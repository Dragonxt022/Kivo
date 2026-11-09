import { getPool } from './db';

/**
 * Blocos de acesso do painel Cloud.
 *
 * Cada bloco corresponde a uma área navegável do painel e é a unidade de permissão
 * usada pelos grupos (Administrador, Afiliados, Suporte e os grupos criados depois).
 * A mesma lista alimenta:
 *   - os cards da tela inicial (com busca e favoritos);
 *   - as caixas de seleção da tela de grupos de permissão;
 *   - o guard de rotas em `requireAdminAuth`.
 */
export interface AdminBlock {
  key: string;
  label: string;
  description: string;
  href: string;
  category: string;
  icon: string;
  /** Termos extras para a busca da tela inicial. */
  keywords: string;
}

export const ADMIN_CATEGORIES = [
  'Visão geral',
  'Comercial',
  'Relacionamento',
  'Conteúdo',
  'Sistema',
  'Administração',
] as const;

export const ADMIN_BLOCKS: AdminBlock[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    description: 'Indicadores, receita, sincronizações e avisos do negócio.',
    href: '/admin/dashboard',
    category: 'Visão geral',
    icon: 'dashboard',
    keywords: 'painel kpi indicadores receita sincronização',
  },
  {
    key: 'companies',
    label: 'Empresas',
    description: 'Cadastro, licenças, planos e dispositivos das empresas.',
    href: '/admin/companies',
    category: 'Visão geral',
    icon: 'companies',
    keywords: 'clientes licença chave plano empresa',
  },
  {
    key: 'usage',
    label: 'Uso das empresas',
    description: 'Quanto cada empresa sincroniza e usa o Kivo.',
    href: '/admin/usage',
    category: 'Visão geral',
    icon: 'usage',
    keywords: 'consumo uso sincronizações métricas',
  },
  {
    key: 'devices',
    label: 'Dispositivos',
    description: 'Máquinas conectadas, testes e versões em campo.',
    href: '/admin/devices',
    category: 'Visão geral',
    icon: 'devices',
    keywords: 'máquinas computadores instalações trial',
  },
  {
    key: 'downloads',
    label: 'Downloads e testes',
    description: 'Cadastros de download, instaladores e testes.',
    href: '/admin/downloads',
    category: 'Visão geral',
    icon: 'downloads',
    keywords: 'instalador build versão teste download',
  },
  {
    key: 'versions',
    label: 'Versões',
    description: 'Distribuição das versões do Kivo instaladas.',
    href: '/admin/versions',
    category: 'Visão geral',
    icon: 'versions',
    keywords: 'releases atualização versão distribuída',
  },
  {
    key: 'leads',
    label: 'Leads',
    description: 'Contatos interessados no Kivo e acompanhamento comercial.',
    href: '/admin/leads',
    category: 'Comercial',
    icon: 'leads',
    keywords: 'prospects contatos whatsapp vendas',
  },
  {
    key: 'contracts',
    label: 'Contratos',
    description: 'Contratos, parcelas e documentos assinados.',
    href: '/admin/contracts',
    category: 'Comercial',
    icon: 'contracts',
    keywords: 'parcelas documento assinatura',
  },
  {
    key: 'subscriptions',
    label: 'Assinaturas',
    description: 'Assinaturas recorrentes e sincronização de cobranças.',
    href: '/admin/subscriptions',
    category: 'Comercial',
    icon: 'subscriptions',
    keywords: 'recorrência mensalidade renovação',
  },
  {
    key: 'charges',
    label: 'Cobranças',
    description: 'Faturas emitidas, pagamentos e inadimplência.',
    href: '/admin/charges',
    category: 'Comercial',
    icon: 'charges',
    keywords: 'faturas pagamentos vencidas boleto pix',
  },
  {
    key: 'plans',
    label: 'Planos e preços',
    description: 'Planos, valores, promoções e selos comerciais.',
    href: '/admin/plans',
    category: 'Comercial',
    icon: 'plans',
    keywords: 'preço prata ouro diamante trial promoção',
  },
  {
    key: 'gateways',
    label: 'Gateways de pagamento',
    description: 'Integrações de pagamento e checkout.',
    href: '/admin/gateways',
    category: 'Comercial',
    icon: 'gateways',
    keywords: 'mercadopago pagarme checkout cartão pix',
  },
  {
    key: 'affiliates',
    label: 'Afiliados',
    description: 'Parceiros, indicações e cadastro de afiliados.',
    href: '/admin/affiliates',
    category: 'Comercial',
    icon: 'affiliates',
    keywords: 'parceiros indicações comissão afiliado',
  },
  {
    key: 'commissions',
    label: 'Comissões',
    description: 'Comissões geradas pelas indicações dos afiliados.',
    href: '/admin/commissions',
    category: 'Comercial',
    icon: 'commissions',
    keywords: 'comissão repasse indicação',
  },
  {
    key: 'payouts',
    label: 'Pagamentos de afiliados',
    description: 'Pedidos de saque e pagamentos aos afiliados.',
    href: '/admin/payouts',
    category: 'Comercial',
    icon: 'payouts',
    keywords: 'saque repasse pagamento afiliado',
  },
  {
    key: 'support',
    label: 'Suporte',
    description: 'Tickets de atendimento das empresas.',
    href: '/admin/support',
    category: 'Relacionamento',
    icon: 'support',
    keywords: 'ticket atendimento chamado ajuda',
  },
  {
    key: 'messages',
    label: 'Mensagens',
    description: 'Comunicados enviados às empresas no aplicativo.',
    href: '/admin/messages',
    category: 'Relacionamento',
    icon: 'messages',
    keywords: 'comunicado aviso central mensagem',
  },
  {
    key: 'catalog',
    label: 'Banco de imagens',
    description: 'Curadoria das imagens de produtos enviadas pelas empresas.',
    href: '/admin/catalog',
    category: 'Conteúdo',
    icon: 'catalog',
    keywords: 'imagens fotos produtos curadoria',
  },
  {
    key: 'themes',
    label: 'Temas',
    description: 'Temas visuais disponíveis para personalizar o Kivo.',
    href: '/admin/themes',
    category: 'Conteúdo',
    icon: 'themes',
    keywords: 'aparência cores layout personalização',
  },
  {
    key: 'ai',
    label: 'KIVO IA',
    description: 'Provedores, limites e uso da inteligência artificial.',
    href: '/admin/ai',
    category: 'Sistema',
    icon: 'ai',
    keywords: 'inteligência artificial ollama openai ia',
  },
  {
    key: 'documentacao',
    label: 'Documentação',
    description: 'Documentação técnica e regras de negócio do Kivo.',
    href: '/admin/documentacao',
    category: 'Sistema',
    icon: 'docs',
    keywords: 'wiki docs manual regras suporte',
  },
  {
    key: 'settings',
    label: 'Configurações',
    description: 'Parâmetros gerais, SMTP, integrações e licenças.',
    href: '/admin/settings',
    category: 'Sistema',
    icon: 'settings',
    keywords: 'config smtp email integração geral',
  },
  {
    key: 'errors',
    label: 'Erros',
    description: 'Relatórios de erros enviados pelas instalações.',
    href: '/admin/errors',
    category: 'Sistema',
    icon: 'errors',
    keywords: 'logs falhas exceções diagnóstico',
  },
  {
    key: 'hardware',
    label: 'Inventário',
    description: 'Hardware das máquinas que usam o Kivo.',
    href: '/admin/hardware',
    category: 'Sistema',
    icon: 'hardware',
    keywords: 'máquinas cpu memória inventário equipamento',
  },
  {
    key: 'admins',
    label: 'Administradores',
    description: 'Usuários do painel e seus grupos de permissão.',
    href: '/admin/admins',
    category: 'Administração',
    icon: 'admins',
    keywords: 'usuários acesso login equipe',
  },
  {
    key: 'roles',
    label: 'Grupos de permissão',
    description: 'Crie grupos e defina quais blocos cada um pode acessar.',
    href: '/admin/cargos',
    category: 'Administração',
    icon: 'roles',
    keywords: 'cargos permissões grupos acesso administrador afiliados suporte',
  },
];

export const ADMIN_PERMISSION_KEYS: string[] = ADMIN_BLOCKS.map((b) => b.key);

const BLOCK_BY_KEY = new Map(ADMIN_BLOCKS.map((b) => [b.key, b]));

export function adminBlock(key: string): AdminBlock | undefined {
  return BLOCK_BY_KEY.get(key);
}

/**
 * Converte o caminho acessado no bloco correspondente.
 *
 * Usa `req.originalUrl` porque `requireAdminAuth` também roda dentro de routers
 * montados em subcaminhos (`/admin/messages`, `/admin/usage`, ...); nesses casos
 * `req.path` já vem sem o prefixo e não identificaria o bloco.
 */
export function blockForPath(originalUrl: string): string | null {
  let path = String(originalUrl || '/').split('?')[0];
  if (!path.startsWith('/')) path = '/' + path;

  // `requireAdminAuth` recebe a URL completa, inclusive o prefixo de montagem.
  // Removemos `/admin` para comparar com os caminhos internos do painel.
  if (path === '/admin') path = '/';
  else if (path.startsWith('/admin/')) path = path.slice('/admin'.length);

  // Rotas sempre liberadas para qualquer usuário autenticado.
  if (
    path === '/' ||
    path === '/profile' ||
    path === '/api/search' ||
    path === '/api/notifications' ||
    path === '/logout'
  ) {
    return null;
  }

  // Sub-rotas de API que herdam o bloco da área principal.
  if (path.startsWith('/api/companies/')) return 'companies';
  if (path.startsWith('/api/search')) return null;
  if (path.startsWith('/api/notifications')) return null;
  if (path.startsWith('/trials/')) return 'devices';

  const segment = path.split('/')[1] || '';
  const map: Record<string, string> = {
    dashboard: 'dashboard',
    companies: 'companies',
    usage: 'usage',
    devices: 'devices',
    downloads: 'downloads',
    versions: 'versions',
    leads: 'leads',
    contracts: 'contracts',
    subscriptions: 'subscriptions',
    charges: 'charges',
    plans: 'plans',
    gateways: 'gateways',
    payments: 'gateways',
    affiliates: 'affiliates',
    commissions: 'commissions',
    payouts: 'payouts',
    support: 'support',
    messages: 'messages',
    catalog: 'catalog',
    themes: 'themes',
    ai: 'ai',
    documentacao: 'documentacao',
    settings: 'settings',
    errors: 'errors',
    hardware: 'hardware',
    admins: 'admins',
    cargos: 'roles',
    roles: 'roles',
  };
  return map[segment] ?? null;
}

export interface AdminAccess {
  username: string;
  roleId: number | null;
  roleSlug: string;
  roleName: string;
  permissions: Set<string>;
  /** true quando o usuário ainda não tem grupo (instalação antiga). */
  legacy: boolean;
}

/**
 * Carrega o grupo e as permissões do administrador a cada requisição.
 *
 * Antes da migration de grupos, ou para um admin sem `role_id`, liberamos tudo:
 * a instalação antiga continua funcionando até o administrador escolher um grupo.
 */
export async function loadAdminAccess(username: string): Promise<AdminAccess> {
  const all = () => new Set(ADMIN_PERMISSION_KEYS);
  try {
    const [rows] = await getPool().query(
      `SELECT au.role_id, r.slug AS role_slug, r.name AS role_name
         FROM admin_users au
         LEFT JOIN admin_roles r ON r.id = au.role_id
        WHERE au.username = ?`,
      [username],
    );
    const row = (rows as { role_id: number | null; role_slug: string | null; role_name: string | null }[])[0];
    if (!row || row.role_id == null) {
      return {
        username,
        roleId: null,
        roleSlug: 'administrador',
        roleName: 'Administrador',
        permissions: all(),
        legacy: true,
      };
    }
    const [permissionRows] = await getPool().query(
      'SELECT permission_key FROM admin_role_permissions WHERE role_id = ?',
      [row.role_id],
    );
    const permissions = new Set(
      (permissionRows as { permission_key: string }[]).map((p) => p.permission_key),
    );
    return {
      username,
      roleId: Number(row.role_id),
      roleSlug: row.role_slug || 'personalizado',
      roleName: row.role_name || 'Grupo personalizado',
      permissions,
      legacy: false,
    };
  } catch {
    return {
      username,
      roleId: null,
      roleSlug: 'administrador',
      roleName: 'Administrador',
      permissions: all(),
      legacy: true,
    };
  }
}

export async function rolePermissions(roleId: number): Promise<string[]> {
  const [rows] = await getPool().query(
    'SELECT permission_key FROM admin_role_permissions WHERE role_id = ? ORDER BY permission_key',
    [roleId],
  );
  return (rows as { permission_key: string }[]).map((r) => r.permission_key);
}
