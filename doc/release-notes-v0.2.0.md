## Kivo v0.2.0

### Novidades
- **Cardápio online renovado**: nova estrutura de página com busca de produtos.
- **Assistente de configuração inicial (onboarding)**: primeiro acesso guiado passo a passo.
- **Mesas e cozinha**: interface e fluxo de trabalho aprimorados na gestão de mesas e no painel da cozinha.

### Correções
- Corrigido bug em que o instalador podia empacotar arquivos antigos do `dist/` (build agora sempre espelha o conteúdo mais recente).
- Corrigido crash na home pública e migração de banco agora é idempotente (pode rodar mais de uma vez com segurança).
- Corrigida validação de tipo de produto (kits/combos/produzidos) e retorno da API de comandas.

### Internos
- Testes automatizados ampliados e ajustados para o novo padrão de resposta da API.
- Adicionada cobertura de código (`c8`) e QA visual automatizado (Playwright).

---
📥 Baixe o instalador `Kivo-Setup-0.2.0.exe` abaixo. Quem já tem o Kivo instalado recebe o aviso de atualização automaticamente no próximo boot.
