import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ message: 'Olá do módulo hello! O loader de módulos do Kivo funciona.' });
});

export default router;
