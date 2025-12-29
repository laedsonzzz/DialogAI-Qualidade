import express from 'express';
import multer from 'multer';
import sharp from 'sharp';

/**
 * Regras de avatar:
 * - Upload multipart com campo 'avatar'
 * - Tipos permitidos: image/jpeg, image/png
 * - Tamanho máximo: 2 MB
 * - Processar com sharp: crop central + resize para 256x256
 * - Armazenar no Postgres em public.user_avatars (bytea), com content_type e updated_at
 */

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png']);
const MAX_SIZE_BYTES = 2 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error('TIPO_INVALIDO');
      // @ts-ignore
      err.code = 'INVALID_TYPE';
      cb(err);
    }
  },
});

export function profileRoutes(pgClient) {
  const router = express.Router();

  /**
   * GET /api/profile
   * Retorna dados do perfil autenticado + status de avatar
   */
  router.get('/', async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Não autenticado' });
      }

      const u = await pgClient.query(
        `SELECT id, email, full_name, status, is_admin
           FROM public.users
          WHERE id = $1
          LIMIT 1`,
        [userId],
      );
      if (u.rows.length === 0) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
      }

      const a = await pgClient.query(
        `SELECT updated_at
           FROM public.user_avatars
          WHERE user_id = $1
          LIMIT 1`,
        [userId],
      );

      const avatar_present = a.rows.length > 0;
      const avatar_updated_at = avatar_present ? a.rows[0].updated_at : null;

      return res.json({
        user: u.rows[0],
        avatar_present,
        avatar_updated_at,
      });
    } catch (err) {
      console.error('Profile GET error:', err);
      return res.status(500).json({ error: 'Erro ao carregar perfil' });
    }
  });

  /**
   * GET /api/profile/avatar
   * Retorna o avatar binário do usuário autenticado (Content-Type: image/jpeg|image/png) ou 404
   */
  router.get('/avatar', async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Não autenticado' });
      }

      const r = await pgClient.query(
        `SELECT content, content_type
           FROM public.user_avatars
          WHERE user_id = $1
          LIMIT 1`,
        [userId],
      );
      if (r.rows.length === 0) {
        return res.status(404).json({ error: 'Avatar não encontrado' });
      }

      const row = r.rows[0];
      const buf = row.content;
      const type = row.content_type || 'application/octet-stream';

      res.setHeader('Content-Type', type);
      res.setHeader('Content-Length', Buffer.byteLength(buf));
      return res.send(buf);
    } catch (err) {
      console.error('Profile avatar GET error:', err);
      return res.status(500).json({ error: 'Erro ao carregar avatar' });
    }
  });

  /**
   * POST /api/profile/avatar
   * Upload de avatar (campo multipart 'avatar'), com validações e processamento
   */
  router.post('/avatar', (req, res, next) => {
    upload.single('avatar')(req, res, (err) => {
      if (err) {
        // Tratamento de erros do Multer
        // @ts-ignore
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'Arquivo muito grande (máximo 2 MB)', code: 'FILE_TOO_LARGE' });
        }
        // @ts-ignore
        if (err.code === 'INVALID_TYPE') {
          return res.status(400).json({ error: 'Tipo de arquivo inválido. Permitidos: JPEG/PNG', code: 'INVALID_TYPE' });
        }
        console.error('Multer error:', err);
        return res.status(400).json({ error: 'Falha no upload', details: String(err?.message || err) });
      }
      next();
    });
  }, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Não autenticado' });
      }

      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: "Campo 'avatar' ausente no multipart" });
      }

      const mimetype = file.mimetype;
      if (!ALLOWED_TYPES.has(mimetype)) {
        return res.status(400).json({ error: 'Tipo de arquivo inválido. Permitidos: JPEG/PNG', code: 'INVALID_TYPE' });
      }
      if (file.size > MAX_SIZE_BYTES) {
        return res.status(413).json({ error: 'Arquivo muito grande (máximo 2 MB)', code: 'FILE_TOO_LARGE' });
      }

      // Verificação adicional do conteúdo real (defesa contra spoof de mimetype)
      const meta = await sharp(file.buffer).metadata();
      const fmt = String(meta.format || '').toLowerCase();
      if (fmt !== 'jpeg' && fmt !== 'jpg' && fmt !== 'png') {
        return res.status(400).json({ error: 'Tipo de arquivo inválido. Permitidos: JPEG/PNG', code: 'INVALID_TYPE' });
      }

      // Processar: crop central + resize 256x256; preservar formato derivado do conteúdo real
      let pipeline = sharp(file.buffer).resize(256, 256, { fit: 'cover', position: 'center' });

      let outType;
      if (fmt === 'jpeg' || fmt === 'jpg') {
        pipeline = pipeline.jpeg({ quality: 85 });
        outType = 'image/jpeg';
      } else if (fmt === 'png') {
        pipeline = pipeline.png();
        outType = 'image/png';
      } else {
        // fallback defensivo
        pipeline = pipeline.png();
        outType = 'image/png';
      }

      const processed = await pipeline.toBuffer();

      // Upsert no Postgres
      const up = await pgClient.query(
        `INSERT INTO public.user_avatars (user_id, content, content_type, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE
           SET content = EXCLUDED.content,
               content_type = EXCLUDED.content_type,
               updated_at = now()
         RETURNING updated_at`,
        [userId, processed, outType],
      );

      const updated_at = up.rows[0]?.updated_at ?? new Date().toISOString();

      return res.json({
        ok: true,
        avatar_present: true,
        avatar_updated_at: updated_at,
      });
    } catch (err) {
      console.error('Profile avatar POST error:', err);
      return res.status(500).json({ error: 'Erro ao salvar avatar' });
    }
  });

  return router;
}