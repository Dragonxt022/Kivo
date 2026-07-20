/**
 * Registro de serviços do Core (KIVO_PLANO.md §2):
 * "Um App não importa de outro App diretamente — comunicação entre Apps
 *  passa por eventos/serviços do Core."
 * Módulos registram serviços no boot (arquivo `setup` do manifesto) e
 * consomem serviços de outros módulos por nome, sem import direto.
 */
const services = new Map<string, unknown>();

export function registerService(name: string, impl: unknown): void {
  if (services.has(name)) throw new Error(`Serviço já registrado: ${name}`);
  services.set(name, impl);
}

/** Retorna o serviço ou lança erro claro (módulo dependente ausente/desabilitado). */
export function getService<T>(name: string): T {
  const svc = services.get(name);
  if (!svc) {
    throw new Error(
      `Serviço "${name}" não disponível. O módulo que o fornece está instalado e habilitado?`,
    );
  }
  return svc as T;
}

export function hasService(name: string): boolean {
  return services.has(name);
}

/** Uso em testes/reload. */
export function clearServices(): void {
  services.clear();
}
