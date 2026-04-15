require('dotenv').config();

const express    = require('express');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Pool }   = require('pg');
const path       = require('path');
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
// Railway 内部ホスト・ローカルは SSL 不要、外部公開URLのみ SSL
const dbUrl = process.env.DATABASE_URL;
const needsSsl = !dbUrl.includes('localhost') &&
                 !dbUrl.includes('127.0.0.1') &&
                 !dbUrl.includes('.railway.internal');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

async function initDB() {
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
    CREATE TABLE IF NOT EXISTS pins (
      id         BIGINT           PRIMARY KEY,
      project_id VARCHAR(12)      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      time_sec   DOUBLE PRECISION NOT NULL,
      comment    TEXT             NOT NULL,
      resolved   BOOLEAN          NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ      NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS replies (
      id         BIGINT           PRIMARY KEY,
      pin_id     BIGINT           NOT NULL REFERENCES pins(id) ON DELETE CASCADE,
      text       TEXT             NOT NULL,
      created_at TIMESTAMPTZ      NOT NULL DEFAULT NOW()
    );
  `);
  console.log('✅ DB テーブル確認済');
}

function generateId() {
  return randomBytes(5).toString('hex'); // 10文字の16進数
}

// ─── Express ───────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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
        Bucket:      BUCKET,
        Key:         key,
        ContentType: type || 'video/mp4',
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

    for (const pin of (pins || [])) {
      await pool.query(
        'INSERT INTO pins (id, project_id, time_sec, comment, resolved) VALUES ($1, $2, $3, $4, $5)',
        [pin.id, id, pin.time, pin.comment, pin.resolved || false]
      );
      for (const reply of (pin.replies || [])) {
        await pool.query(
          'INSERT INTO replies (id, pin_id, text) VALUES ($1, $2, $3)',
          [reply.id, pin.id, reply.text]
        );
      }
    }

    console.log(`[project] created id=${id} name="${name.trim()}"`);
    res.json({ id });
  } catch (err) {
    console.error('[project] create error:', err);
    res.status(500).json({ error: 'プロジェクトの作成に失敗しました: ' + err.message });
  }
});

// ─── GET /api/projects/:id ─────────────────────────────────
app.get('/api/projects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const proj = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
    if (proj.rows.length === 0) return res.status(404).json({ error: 'プロジェクトが見つかりません' });

    const pinsRes = await pool.query(
      'SELECT * FROM pins WHERE project_id = $1 ORDER BY time_sec',
      [id]
    );
    const repliesRes = await pool.query(
      `SELECT r.* FROM replies r
         JOIN pins p ON r.pin_id = p.id
        WHERE p.project_id = $1`,
      [id]
    );

    const pins = pinsRes.rows.map(pin => ({
      id:       Number(pin.id),
      time:     pin.time_sec,
      comment:  pin.comment,
      resolved: pin.resolved,
      replies:  repliesRes.rows
        .filter(r => Number(r.pin_id) === Number(pin.id))
        .map(r => ({ id: Number(r.id), text: r.text })),
    }));

    res.json({
      id:        proj.rows[0].id,
      name:      proj.rows[0].name,
      videoUrl:  proj.rows[0].video_url,
      videoType: proj.rows[0].video_type,
      fileId:    proj.rows[0].file_id,
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
  const { pins } = req.body;

  try {
    // 既存ピンを全削除（replies は CASCADE で連鎖削除）
    await pool.query('DELETE FROM pins WHERE project_id = $1', [id]);

    for (const pin of (pins || [])) {
      await pool.query(
        'INSERT INTO pins (id, project_id, time_sec, comment, resolved) VALUES ($1, $2, $3, $4, $5)',
        [pin.id, id, pin.time, pin.comment, pin.resolved || false]
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

// ─── SPA フォールバック（/project/:id → index.html）────────
app.get('/project/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
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
