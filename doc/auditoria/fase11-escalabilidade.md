# FASE 11 — Escalabilidade

## Escopo

Análise de capacidade para 100, 500, 1000 e 5000 clientes.

---

## Arquitetura Atual

| Componente | Tecnologia | Limitação |
|------------|-----------|-----------|
| Banco local | SQLite (single-writer) | OK para 1 instância |
| Sync cloud | Express + MySQL (cloud/) | Escalável verticalmente |
| Servidor local | Express single-thread | 1 processo por cliente |
| Desktop | Electron | 1 instância por máquina |

---

## Cenários

### 100 clientes
**Sem problemas.** Cada cliente tem seu próprio SQLite local. O cloud/ com
MySQL aguenta 100 empresas tranquilamente. Sync engine precisa do cache de
PRAGMA (já identificado na F4) para não degradar.

### 500 clientes
**Possível com ajustes.** O cloud/ começa a sentir:
- Sync concorrente: 500 máquinas fazendo push/pull simultâneo
- A rota de validação de licença (`/api/license/validate`) recebe mais calls
- Backup nuvem: 500 clients × 50MB = 25GB de armazenamento

**Recomendações:**
- Cache de PRAGMA no sync (F4)
- Rate limiting no cloud/ para sync requests
- Paginação no collectDirtyRows (F3)
- Índices compostos em `stock_movements`, `sales` (F4)

### 1000 clientes
**Requer mudanças no cloud/:**
- Adicionar Redis para rate limiting e cache de validação de licença
- Pool de conexões MySQL (ou migrar para conexão serverless)
- Processo de backup em fila (não síncrono)
- Monitoramento de saúde do cloud/

### 5000 clientes
**Arquitetura atual não escala sem redesenho:**
- Cloud/ precisa de load balancing horizontal
- MySQL precisa de replicação read replica
- Sync engine precisaria de processamento assíncrono (fila de jobs)
- Backup nuvem precisaria de storage escalável (S3-compatible)
- Possível necessidade de plano enterprise dedicado

---

## Gargalos Identificados

| Gargalo | Impacto em escala | Solução |
|---------|-------------------|---------|
| Sync engine sem cache de PRAGMA | Alto | Cache em Map (F4) |
| collectDirtyRows sem paginação | Alto | LIMIT/OFFSET (F3) |
| Stock recompute síncrono | Alto | Processamento em fila |
| Backup carrega DB inteiro em RAM | Médio | Stream (F3) |
| Cloud/ single process | Alto | Load balance + filas |
| Validação de licença síncrona | Médio | Cache Redis |

---

## Nota da FASE 11: C

**Justificativa:** Para 100-500 clientes, a arquitetura atual é adequada com
os ajustes identificados nas fases anteriores. Acima disso, o cloud/ precisaria
de investimento em infraestrutura (load balancing, Redis, filas). O sync engine
é o maior gargalo técnico.
