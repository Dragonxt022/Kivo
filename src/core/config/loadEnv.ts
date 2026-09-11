import { loadEnvFiles } from './env';

/**
 * Módulo de efeito colateral: importá-lo (como PRIMEIRO import de um entrypoint) garante
 * que o `.env` seja lido antes de qualquer outro módulo avaliar `process.env` no topo.
 * Existe porque `import` é hoisted — chamar `loadEnvFiles()` no corpo do entrypoint viria
 * tarde demais para quem lê env na própria avaliação do módulo.
 */
loadEnvFiles();
