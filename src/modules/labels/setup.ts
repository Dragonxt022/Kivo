import { labelSheetRepository } from './repositories/LabelSheetRepository';

/**
 * Roda no boot, depois das migrations (migrações → seeds → módulos). A tabela
 * `label_sheets` já existe a essa altura; aqui só garantimos que os presets de fábrica
 * (Pimaco etc.) estejam presentes, sem tocar nos modelos criados pelo lojista.
 */
export default function setup(): void {
  labelSheetRepository.seedPresets();
}
