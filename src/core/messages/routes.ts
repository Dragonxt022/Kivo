import { Router } from 'express';
import { assertAuth } from '../../shared/auth';
import { validateBody } from '../../shared/validateBody';
import { z } from 'zod';
import {
  listForUser,
  markRead,
  setFavorite,
  dismiss,
  assignCategory,
  reorder,
  listCategories,
  createCategory,
  deleteCategory,
  urgentPending,
  imageFor,
  CATEGORIAS_FIXAS,
} from './service';

const router = Router();

/** Central de mensagens do app. Qualquer usuário autenticado lê; o estado é por usuário. */
router.get('/', (req, res) => {
  assertAuth(req);
  res.json({
    messages: listForUser(req.user.id),
    categories: listCategories(req.user.id),
    fixedCategories: CATEGORIAS_FIXAS,
  });
});

/** Urgentes ainda não lidas — o aviso da tela inicial lê daqui. */
router.get('/urgent', (req, res) => {
  assertAuth(req);
  res.json({ messages: urgentPending(req.user.id) });
});

router.get('/image/:uuid', async (req, res) => {
  assertAuth(req);
  const img = await imageFor(String(req.params.uuid));
  if (!img) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(Buffer.from(img.b64, 'base64'));
});

const readSchema = z.object({ read: z.boolean().optional() });
router.post('/:uuid/read', validateBody(readSchema), (req, res) => {
  assertAuth(req);
  markRead(req.user.id, String(req.params.uuid), req.body.read !== false);
  res.json({ ok: true });
});

const favoriteSchema = z.object({ favorite: z.boolean() });
router.post('/:uuid/favorite', validateBody(favoriteSchema), (req, res) => {
  assertAuth(req);
  setFavorite(req.user.id, String(req.params.uuid), req.body.favorite);
  res.json({ ok: true });
});

router.post('/:uuid/dismiss', (req, res) => {
  assertAuth(req);
  dismiss(req.user.id, String(req.params.uuid));
  res.json({ ok: true });
});

const categorySchema = z.object({ categoryId: z.number().int().positive().nullable() });
router.post('/:uuid/category', validateBody(categorySchema), (req, res) => {
  assertAuth(req);
  assignCategory(req.user.id, String(req.params.uuid), req.body.categoryId);
  res.json({ ok: true });
});

const reorderSchema = z.object({ uuids: z.array(z.string()).max(500) });
router.post('/reorder', validateBody(reorderSchema), (req, res) => {
  assertAuth(req);
  reorder(req.user.id, req.body.uuids);
  res.json({ ok: true });
});

const newCategorySchema = z.object({ name: z.string().min(1).max(60) });
router.post('/categories', validateBody(newCategorySchema), (req, res) => {
  assertAuth(req);
  const created = createCategory(req.user.id, req.body.name);
  if (!created) {
    res.status(400).json({ error: 'Já existe uma categoria com esse nome.' });
    return;
  }
  res.status(201).json(created);
});

router.delete('/categories/:id', (req, res) => {
  assertAuth(req);
  deleteCategory(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

export default router;
