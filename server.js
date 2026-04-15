require('dotenv').config();

const express    = require('express');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path       = require('path');
const { randomUUID } = require('crypto'); // Node 14.17+

// ─── 起動時バリデーション ───────────────────────────────────
const required = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_ENDPOINT'];
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

// ─── Express ───────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

// index.html を静的配信
app.use(express.static(path.join(__dirname)));

// ─── GET /api/presign ──────────────────────────────────────
// query: filename (必須), type (任意, デフォルト video/mp4)
// response: { uploadUrl, publicUrl, key }
app.get('/api/presign', async (req, res) => {
  const { filename, type } = req.query;
  if (!filename) return res.status(400).json({ error: 'filename が必要です' });

  try {
    // ユニークなキーを生成（同名ファイルの衝突を防ぐ）
    const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${Date.now()}-${randomUUID()}-${safeFilename}`;
    // PUT 用 Presigned URL（1時間有効）
    const uploadUrl = await getSignedUrl(
      r2,
      new PutObjectCommand({
        Bucket:      BUCKET,
        Key:         key,
        ContentType: type || 'video/mp4',
      }),
      { expiresIn: 3600 }
    );

    // 公開URLの決定
    // 優先: R2_PUBLIC_BASE_URL（バケットの公開アクセスを有効にした場合）
    // フォールバック: 署名付き GET URL（7日間有効）
    let publicUrl;
    if (PUBLIC_BASE_URL) {
      publicUrl = `${PUBLIC_BASE_URL}/${key}`;
    } else {
      publicUrl = await getSignedUrl(
        r2,
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
        { expiresIn: 60 * 60 * 24 * 7 } // 7日
      );
    }

    console.log(`[presign] key=${key} type=${type} publicUrl=${publicUrl.slice(0, 60)}...`);
    res.json({ uploadUrl, publicUrl, key });

  } catch (err) {
    console.error('[presign] error:', err);
    res.status(500).json({ error: 'Presigned URL の生成に失敗しました: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ サーバー起動: http://localhost:${PORT}`);
  console.log(`   バケット: ${BUCKET}`);
  console.log(`   公開URL設定: ${PUBLIC_BASE_URL || '未設定（署名付きURLを使用）'}`);
});
