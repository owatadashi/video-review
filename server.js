require('dotenv').config();

const express    = require('express');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Pool }   = require('pg');
const path       = require('path');
const fs         = require('fs');
const { randomUUID, randomBytes } = require('crypto');

// ─── 起動時バリデーション ───────────────────────────────────
const required = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_ENDPOINT', 'DATABASE_URL'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ .env に以下の変数が設定されていません:', missing.join(', '));
  process.exit(1);
}

// ─── R2 クライアント ───────────────────────────────────────
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET          = process.env.R2_BUCKET_NAME;
const PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/$/, '');

// ─── PostgreSQL ────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL;
const needsSsl = !dbUrl.includes('localhost') &&
                 !dbUrl.includes('127.0.0.1') &&
                 !dbUrl.includes('.railway.internal');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  // ── テーブル作成 ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id         VARCHAR(12)      PRIMARY KEY,
      name       TEXT             NOT NULL,
      video_url  TEXT             NOT NULL DEFAULT '',
      video_type TEXT             NOT NULL DEFAULT 'direct',
      file_id    TEXT             NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ      NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS project_versions (
      id          SERIAL          PRIMARY KEY,
      project_id  VARCHAR(12)     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      version_num INTEGER         NOT NULL,
      video_url   TEXT            NOT NULL DEFAULT '',
      video_type  TEXT            NOT NULL DEFAULT 'direct',
      file_id     TEXT            NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, version_num)
    );
    CREATE TABLE IF NOT EXISTS pins (
      id          BIGINT           PRIMARY KEY,
      project_id  VARCHAR(12)      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      time_sec    DOUBLE PRECISION NOT NULL,
      comment     TEXT             NOT NULL,
      resolved    BOOLEAN          NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS replies (
      id         BIGINT           PRIMARY KEY,
      pin_id     BIGINT           NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
      text       TEXT             NOT NULL,
      created_at TIMESTAMPTZ      NOT NULL DEFAULT NOW()
    );
  `);

  // ── マイグレーション: 既存 pins テーブルに新カラムを追加 ──
  await pool.query(`
    ALTER TABLE pins ADD COLUMN IF NOT EXISTS version_id INTEGER REFERENCES project_versions(id) ON DELETE SET NULL;
    ALTER TABLE pins ADD COLUMN IF NOT EXISTS author TEXT NOT NULL DEFAULT '';
    ALTER TABLE pins ADD COLUMN IF NOT EXISTS annotation TEXT;
  `);

  // ── マイグレーション: バージョンを持たないプロジェクトに v1 を作成 ──
  await pool.query(`
    INSERT INTO project_versions (project_id, version_num, video_url, video_type, file_id, created_at)
    SELECT id, 1, video_url, video_type, file_id, created_at
    FROM projects
    WHERE id NOT IN (SELECT DISTINCT project_id FROM project_versions)
    ON CONFLICT DO NOTHING;
  `);

  // ── マイグレーション: version_id が NULL のピンを v1 に紐付け ──
  await pool.query(`
    UPDATE pins SET version_id = (
      SELECT pv.id FROM project_versions pv
      WHERE pv.project_id = pins.project_id AND pv.version_num = 1
    )
    WHERE version_id IS NULL;
  `);

  console.log('✅ DB テーブル確認済');
}

function generateId() {
  return randomBytes(5).toString('hex');
}

// ─── Express ───────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));


app.use(express.static(path.join(__dirname)));

// ─── GET /api/presign ──────────────────────────────────────
app.get('/api/presign', async (req, res) => {
  const { filename, type } = req.query;
  if (!filename) return res.status(400).json({ error: 'filename が必要です' });

  try {
    const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${Date.now()}-${randomUUID()}-${safeFilename}`;

    const uploadUrl = await getSignedUrl(
      r2,
      new PutObjectCommand({
        Bucket:        BUCKET,
        Key:           key,
        ContentType:   type || 'video/mp4',
        CacheControl:  'public, max-age=2592000',
      }),
      { expiresIn: 3600 }
    );

    let publicUrl;
    if (PUBLIC_BASE_URL) {
      publicUrl = `${PUBLIC_BASE_URL}/${key}`;
    } else {
      publicUrl = await getSignedUrl(
        r2,
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
        { expiresIn: 60 * 60 * 24 * 7 }
      );
    }

    console.log(`[presign] key=${key} publicUrl=${publicUrl.slice(0, 60)}...`);
    res.json({ uploadUrl, publicUrl, key });
  } catch (err) {
    console.error('[presign] error:', err);
    res.status(500).json({ error: 'Presigned URL の生成に失敗しました: ' + err.message });
  }
});

// ─── POST /api/projects ────────────────────────────────────
app.post('/api/projects', async (req, res) => {
  const { name, videoUrl, videoType, fileId, pins } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name が必要です' });

  try {
    const id = generateId();
    await pool.query(
      'INSERT INTO projects (id, name, video_url, video_type, file_id) VALUES ($1, $2, $3, $4, $5)',
      [id, name.trim(), videoUrl || '', videoType || 'direct', fileId || '']
    );

    // v1 を作成
    const vRes = await pool.query(
      'INSERT INTO project_versions (project_id, version_num, video_url, video_type, file_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [id, 1, videoUrl || '', videoType || 'direct', fileId || '']
    );
    const versionId = vRes.rows[0].id;

    for (const pin of (pins || [])) {
      await pool.query(
        'INSERT INTO pins (id, project_id, version_id, time_sec, comment, author, resolved, annotation) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [pin.id, id, versionId, pin.time, pin.comment, pin.author || '', pin.resolved || false, pin.annotation || null]
      );
      for (const reply of (pin.replies || [])) {
        await pool.query(
          'INSERT INTO replies (id, pin_id, text) VALUES ($1, $2, $3)',
          [reply.id, pin.id, reply.text]
        );
      }
    }

    console.log(`[project] created id=${id} name="${name.trim()}"`);
    res.json({ id, versionId, versionNum: 1 });
  } catch (err) {
    console.error('[project] create error:', err);
    res.status(500).json({ error: 'プロジェクトの作成に失敗しました: ' + err.message });
  }
});

// ─── GET /api/projects/:id ─────────────────────────────────
// ?v=N でバージョン番号指定（省略時は最新版）
app.get('/api/projects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const vParam = req.query.v ? parseInt(req.query.v) : null;

    const proj = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'プロジェクトが見つかりません' });

    // 全バージョン取得
    const versionsRes = await pool.query(
      'SELECT * FROM project_versions WHERE project_id = $1 ORDER BY version_num',
      [id]
    );
    const versions = versionsRes.rows;

    // 対象バージョンを決定（指定なし or 存在しない場合は最新）
    let currentVersion = null;
    if (vParam && versions.length > 0) {
      currentVersion = versions.find(v => v.version_num === vParam) || null;
    }
    if (!currentVersion && versions.length > 0) {
      currentVersion = versions[versions.length - 1]; // 最新
    }

    const maxVersionId = versions.length > 0 ? Math.max(...versions.map(v => v.id)) : null;
    const isLatestVersion = !currentVersion || currentVersion.id === maxVersionId;

    // 対象バージョンのピン取得
    let pinsRows = [];
    if (currentVersion) {
      const pinsRes = await pool.query(
        'SELECT * FROM pins WHERE version_id = $1 ORDER BY time_sec',
        [currentVersion.id]
      );
      pinsRows = pinsRes.rows;
    } else {
      // バージョンなし（旧データ）: project_id で全取得
      const pinsRes = await pool.query(
        'SELECT * FROM pins WHERE project_id = $1 ORDER BY time_sec',
        [id]
      );
      pinsRows = pinsRes.rows;
    }

    // 返信取得
    let replies = [];
    if (pinsRows.length > 0) {
      const pinIds = pinsRows.map(p => p.id);
      const repliesRes = await pool.query(
        'SELECT r.* FROM replies r WHERE r.pin_id = ANY($1)',
        [pinIds]
      );
      replies = repliesRes.rows;
    }

    const pins = pinsRows.map(pin => ({
      id:         Number(pin.id),
      time:       pin.time_sec,
      comment:    pin.comment,
      author:     pin.author || '',
      resolved:   pin.resolved,
      ...(pin.annotation ? { annotation: pin.annotation } : {}),
      replies:  replies
        .filter(r => Number(r.pin_id) === Number(pin.id))
        .map(r => ({ id: Number(r.id), text: r.text })),
    }));

    res.json({
      id:               proj.rows[0].id,
      name:             proj.rows[0].name,
      videoUrl:         currentVersion?.video_url  || proj.rows[0].video_url,
      videoType:        currentVersion?.video_type || proj.rows[0].video_type,
      fileId:           currentVersion?.file_id    || proj.rows[0].file_id || '',
      createdAt:        proj.rows[0].created_at,
      currentVersionId:  currentVersion?.id || null,
      currentVersionNum: currentVersion?.version_num || 1,
      isLatestVersion,
      versions: versions.map(v => ({
        id:         v.id,
        versionNum: v.version_num,
        videoUrl:   v.video_url,
        videoType:  v.video_type,
        fileId:     v.file_id || '',
        createdAt:  v.created_at,
      })),
      pins,
    });
  } catch (err) {
    console.error('[project] get error:', err);
    res.status(500).json({ error: 'プロジェクトの取得に失敗しました: ' + err.message });
  }
});

// ─── PUT /api/projects/:id/pins ────────────────────────────
app.put('/api/projects/:id/pins', async (req, res) => {
  const { id } = req.params;
  const { pins, versionId } = req.body;

  try {
    if (versionId) {
      // 指定バージョンのピンのみ削除（replies は CASCADE で連鎖削除）
      await pool.query('DELETE FROM pins WHERE version_id = $1', [versionId]);
    } else {
      // バージョン未指定: プロジェクト全ピン削除（旧データ互換）
      await pool.query('DELETE FROM pins WHERE project_id = $1', [id]);
    }

    for (const pin of (pins || [])) {
      await pool.query(
        'INSERT INTO pins (id, project_id, version_id, time_sec, comment, author, resolved) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [pin.id, id, versionId || null, pin.time, pin.comment, pin.author || '', pin.resolved || false]
      );
      for (const reply of (pin.replies || [])) {
        await pool.query(
          'INSERT INTO replies (id, pin_id, text) VALUES ($1, $2, $3)',
          [reply.id, pin.id, reply.text]
        );
      }
    }

    await pool.query('UPDATE projects SET updated_at = NOW() WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[project] update pins error:', err);
    res.status(500).json({ error: 'ピンの保存に失敗しました: ' + err.message });
  }
});

// ─── POST /api/projects/:id/versions ──────────────────────
// 新バージョン作成（前バージョンのコメントをコピー）
app.post('/api/projects/:id/versions', async (req, res) => {
  const { id } = req.params;
  const { videoUrl, videoType, fileId, copyFromVersionId } = req.body;

  try {
    // 最新バージョン番号を取得
    const maxRes = await pool.query(
      'SELECT COALESCE(MAX(version_num), 0) AS max_num FROM project_versions WHERE project_id = $1',
      [id]
    );
    const newVersionNum = Number(maxRes.rows[0].max_num) + 1;

    // 新バージョン作成
    const vRes = await pool.query(
      'INSERT INTO project_versions (project_id, version_num, video_url, video_type, file_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [id, newVersionNum, videoUrl || '', videoType || 'direct', fileId || '']
    );
    const newVersionId = vRes.rows[0].id;

    // 前バージョンからコメントをコピー
    if (copyFromVersionId) {
      const srcPins = await pool.query(
        'SELECT * FROM pins WHERE version_id = $1 ORDER BY time_sec',
        [copyFromVersionId]
      );

      for (const pin of srcPins.rows) {
        const newPinId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
        await pool.query(
          'INSERT INTO pins (id, project_id, version_id, time_sec, comment, author, resolved, annotation) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [newPinId, id, newVersionId, pin.time_sec, pin.comment, pin.author || '', pin.resolved, pin.annotation || null]
        );

        const srcReplies = await pool.query('SELECT * FROM replies WHERE pin_id = $1', [pin.id]);
        for (const reply of srcReplies.rows) {
          const newReplyId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
          await pool.query(
            'INSERT INTO replies (id, pin_id, text) VALUES ($1, $2, $3)',
            [newReplyId, newPinId, reply.text]
          );
        }
      }
    }

    console.log(`[version] created project=${id} v${newVersionNum} id=${newVersionId}`);
    res.json({ versionId: newVersionId, versionNum: newVersionNum });
  } catch (err) {
    console.error('[version] create error:', err);
    res.status(500).json({ error: 'バージョンの作成に失敗しました: ' + err.message });
  }
});

// ─── DELETE /api/projects/:id/versions/:versionId ─────────
app.delete('/api/projects/:id/versions/:versionId', async (req, res) => {
  const { id, versionId } = req.params;
  try {
    // 最低1つはバージョンが残ることを確認
    const countRes = await pool.query(
      'SELECT COUNT(*) FROM project_versions WHERE project_id = $1',
      [id]
    );
    if (parseInt(countRes.rows[0].count) <= 1) {
      return res.status(400).json({ error: '最後のバージョンは削除できません' });
    }

    // 対象バージョンがこのプロジェクトのものか確認
    const vRes = await pool.query(
      'SELECT id FROM project_versions WHERE id = $1 AND project_id = $2',
      [versionId, id]
    );
    if (vRes.rows.length === 0) {
      return res.status(404).json({ error: 'バージョンが見つかりません' });
    }

    // ピンを先に削除（replies は CASCADE で連鎖削除）
    await pool.query('DELETE FROM pins WHERE version_id = $1', [versionId]);
    await pool.query('DELETE FROM project_versions WHERE id = $1', [versionId]);

    console.log(`[version] deleted versionId=${versionId} project=${id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[version] delete error:', err);
    res.status(500).json({ error: 'バージョンの削除に失敗しました: ' + err.message });
  }
});

// ─── /privacy → privacy.html ──────────────────────────────
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy.html'));
});

// ─── /usage → usage.html ──────────────────────────────────
app.get('/usage', (req, res) => {
  res.sendFile(path.join(__dirname, 'usage.html'));
});

// ─── SPA フォールバック（/project/:id → index.html + 動的タイトル）────────
app.get('/project/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT name FROM projects WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.sendFile(path.join(__dirname, 'index.html'));
    const name = result.rows[0].name.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    html = html
      .replace(/(<title>)[^<]*(<\/title>)/, `$1${name} - Clippin$2`)
      .replace(/(<meta property="og:title" content=")[^"]*(")/,    `$1${name} - Clippin$2`)
      .replace(/(<meta name="twitter:title" content=")[^"]*(")/,   `$1${name} - Clippin$2`);
    res.send(html);
  } catch (e) {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

// ─── サーバー起動 ───────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ サーバー起動: http://localhost:${PORT}`);
      console.log(`   バケット: ${BUCKET}`);
      console.log(`   公開URL設定: ${PUBLIC_BASE_URL || '未設定（署名付きURLを使用）'}`);
    });
  })
  .catch(err => {
    console.error('❌ DB 初期化失敗。サーバーを起動できません:', err.message);
    process.exit(1);
  });
