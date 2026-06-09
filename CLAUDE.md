# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

IsiHunter is a Chrome Extension (Manifest V3) for Instagram lead prospecting. It collects Instagram profiles via the Instagram internal private API (not DOM scraping), qualifies them via **local filters + local scoring algorithm** (zero AI tokens), and **optionally** generates two personalized DM messages per approved profile (icebreaker + hook) via OpenAI gpt-4o on demand. Approved leads can be sent to an external CRM via webhook.

There is **no legacy AI qualification path** — every profile is filtered/scored locally. OpenAI is used only for message generation when the user explicitly clicks "Gerar mensagens".

## How to load/test the extension

There is no build step. Load directly in Chrome:

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select this directory
4. After any code change: click the refresh icon on the extension card
5. **Cache busting**: after changing `popup.js`, increment the `?v=N` suffix on the script tag in `popup.html` — Chrome caches ES Modules aggressively

## Architecture

### Module map

| File | Purpose |
|------|---------|
| `background.js` | Service worker — orchestrator (message router, pipeline, IG block state machine, multi-source iteration) |
| `content.js` | Injected in instagram.com — calls IG internal API, extracts profile + recent posts metrics, sends DMs, posts comments, shows floating pill |
| `popup.js` | UI controller — 4 separate form handlers (search/messages/webhook/advanced), banners, log, profile cards, generate-messages handlers, license screens |
| `popup.html` / `popup.css` | UI markup + styles |
| `db.js` | `chrome.storage.local` helpers (settings, profiles, stats, log, blacklist, graylist, history) + `incrementStat` |
| `filters.js` | Pure functions: `passesFilters()`, `matchesKeyword()` (case+accent-insensitive, whole word), `parseKeywords()` |
| `score.js` | Pure function: `calculateScore()` returns `{ score: 0-10 (1 decimal), breakdown }` based on filter dimensions |
| `openai.js` | OpenAI calls — `generateIcebreaker`, `generateHook`, `generateComment` (all on-demand, never auto) |
| `webhook.js` | Builds and POSTs payload to Supabase Edge Function |
| `sync.js` | License validation against isipanel; intentionally inconspicuous names |
| `igBlockDetector.js` | Pure functions: `classifyFailure()` (hard/soft), `shouldTriggerBlock()`, `blockMessage()` |
| `contactExtractor.js` | Pure functions: `extractEmails()`, `extractPhones()`, `extractWhatsAppFromUrl()`, `extractMailtoFromUrl()`, `extractFromProfile()` — regex-only, sem fetch externo (Fase 5a) |

### Popup tab structure (7 tabs)

| data-tab | Label | Conteúdo |
|---|---|---|
| `prospecting` | Busca | Botão Iniciar/Parar + banners (coleta/bloqueio) + triagem por lista + stats + log + **form `search-form`** (fontes + filtros) |
| `list` | Aprovados | Lista de perfis aprovados + bulk-actions (gerar mensagens) |
| `history` | Hist. | Todos os perfis analisados (aprovados + descartados) |
| `messages` | Msgs | **form `messages-form`** — ICP + Produto + Instrução de Abordagem + Chave OpenAI + Prompts customizados |
| `webhook` | Webhook | **form `webhook-form`** — endpoint + apikey + funil + stage + tags + auto-send |
| `settings` | Avançado | **form `settings-form`** — anti-detecção + backup + blacklist/graylist |
| `license` | Licença | Tela de gerenciamento de licença (estados: no_key/valid/expired/blocked/invalid/rate_limited/network_error/server_error) |

Cada form salva apenas seus próprios campos (lê o cfg completo, sobrescreve só os fields da aba, salva).

### Message flow

All coordination goes through `chrome.runtime.sendMessage`. The three execution contexts communicate like this:

```
popup.js  ──sendToBg()──►  background.js  ──sendToContent()──►  content.js
                                │                                     │
                                │◄────── PROFILE_DATA ────────────────┘
                                │◄────── IG_FETCH_FAILED ─────────────┘
                                │◄────── COLLECTION_DONE/ERROR ───────┘
                         (filters → score → save; OpenAI only on-demand)
popup.js  ◄── broadcast() ── background.js  (PROGRESS, IG_BLOCK_*, MESSAGES_*, etc.)
```

### Pipeline de processamento de perfil

**Por perfil coletado** (`processProfile` em background.js):
1. `content.js` envia `PROFILE_DATA` com `seguidores_raw`, `data_ultimo_post`, `posts_recentes`, `engajamento_pct`
2. `background.js` chama `buildFiltersFromSettings(cfg)` → constrói objeto filters dos 5 critérios
3. `filters.passesFilters(profile, filters)` retorna `{ passed, reason? }`
4. Se reprovou: graylist (30d) + history + log `filter_reject` + telemetria `descartados_local`
5. Se passou: `score.calculateScore(profile, filters)` retorna `{ score, breakdown }`
6. Salva em `isi_profiles` (com `score_local`, `score_breakdown`, sem mensagens)
7. Blacklist + history + telemetria `aprovados_local`
8. Se `webhookAuto`: dispara webhook (com mensagens vazias se ainda não geradas, `has_messages: false`)

**Geração de mensagens** (`generateMessagesFor` — sob demanda):
1. Triggered via `GENERATE_MESSAGES { usernames: [] }` do popup
2. Requer `cfg.openaiKey` configurada — lança erro se ausente
3. Para cada username: `generateIcebreaker + generateHook` em paralelo (Promise.all), depois `generateComment` sequencial
4. `saveProfile` com mensagens + `mensagens_geradas_em`
5. Broadcast `MESSAGES_GENERATING` / `MESSAGES_GENERATED` / `MESSAGES_FAILED` por username

### Multi-source iteration

Settings determinam quais fontes estão ativas (`fonteHashtagAtiva`, `fonteSeguidoresAtiva`, etc.). `startProspecting` constrói o array `sources`:

```js
sources = [
  { type: 'hashtag',    list: [...] },
  { type: 'seguidores', perfil: 'x' },
]
```

Persistido em `isi_stats.sources`. `runNextSource()` dispatcha:

- `runHashtagSource(source)` — itera `source.list` com `stats.hashtag_idx`, navega a tab IG entre hashtags, envia `START_COLLECTION` por hashtag
- `runSeguidoresSource(source)` — navega tab IG pra `instagram.com/`, envia `START_FOLLOWERS_COLLECTION { perfil }` uma única vez
- `runEngajamentoSource(source)` — navega tab IG pra `instagram.com/`, envia `START_ENGAJAMENTO_COLLECTION { perfil, nPosts }` uma única vez
- `runPalavrasChaveSource(source)` — navega tab IG pra `instagram.com/`, envia `START_KEYWORDS_COLLECTION { keywords }` uma única vez

Quando uma source termina (`COLLECTION_DONE`), `onCollectionDone` decide:
- Hashtag source com mais hashtags: chama `runHashtagSource` de novo (avança `hashtag_idx`)
- Source esgotada: incrementa `source_idx` e chama `runNextSource()`
- Todas as sources esgotadas: encerra sessão (`active = false`), broadcast `collection_done`

### Source "seguidores de @perfil" (content.js)

Implementada em `collectProfilesFromFollowers(perfil)`:
1. Resolve `@perfil` → user_id via `fetchProfileInfo`
2. Rejeita se perfil é privado (não dá pra ler followers)
3. Pagina `/api/v1/friendships/<id>/followers/?count=50&max_id=...`
4. Limite de segurança: **100 páginas (~5000 perfis)** por sessão
5. Para cada follower username:
   - Dedupe via `seenUsernames` Set
   - Checa blacklist/graylist
   - `fetchProfileInfo` + `buildProfileData` (mesmas chamadas do flow de hashtag)
   - Envia `PROFILE_DATA` pro background
6. Aplica o mesmo pacing (delays entre perfis + pausas entre grupos)
7. Pausa de 2-5s entre páginas de followers

### Extração de contatos (Fase 5a — `contactExtractor.js`)

Gated por `cfg.extrairContatos` (toggle na aba Avançado, default OFF). Quando ativo, `processProfileLocal` chama `extractFromProfile(profileData)` e salva o resultado em `profile.contatos`. Pure regex — sem fetch externo, sem mudança de permissions.

**Fontes vasculhadas:**
- `profile.bio` — texto (regex de email + telefone BR com prefixo +55 ou palavra-chave de contexto)
- `profile.external_url` + `profile.bio_links[].url` — URLs diretas (wa.me/api.whatsapp.com/web.whatsapp.com pra WhatsApp; chat.whatsapp.com pra grupo; mailto: pra email)

**`profile.contatos` shape:**
```js
{
  emails:           ['contato@ex.com', ...],
  phones:           ['+5511999999999', ...],
  whatsapps:        ['+5511999999999', ...],  // subset de phones detectados como celular BR + WA-direto
  grupos_whatsapp:  ['https://chat.whatsapp.com/XXXX', ...],
  has_contact:      bool,
}
```

**Heurísticas:**
- Email ofuscado ("x (at) y (dot) com") é remontado via regex (`EMAIL_OBFUSC_RE`)
- Telefone só é capturado se vier com prefixo `+55`/`55` explícito OU com palavra-chave próxima (`tel`, `whats`, `cel`, emoji 📱/📞)
- Celular BR (`+55 DDD 9XXXXXXXX`) entra automaticamente em `whatsapps`

**UI:**
- Cards mostram badges `📧 email`, `📱 +5511...` (clicáveis pra copiar email/phone; WhatsApp abre `wa.me/<num>` em nova aba)
- Novo chip de filtro na aba Aprovados: "📧 Com contato"
- Webhook payload ganha `extracted_emails[]`, `extracted_whatsapps[]`, `extracted_phones[]`, `has_contact: bool`

**LGPD/legal:** o usuário do IsiHunter é o controller dos dados. Toggle inclui aviso na hint.

### Source "palavras-chave" (content.js)

Implementada em `collectProfilesFromKeywords(keywords)`:
1. Recebe array de keywords (até 10, parsed em background via `parseCsvList`)
2. Para cada keyword:
   - `fetchTopsearchUsers(query)` — `/api/v1/web/search/topsearch/?context=blended&query=<q>` retorna `{ users: [{ position, user: {...} }] }` (~50 perfis por query, sem paginação)
   - Extrai `.user` de cada item, dedupe via `seenUsernames` Set
   - Pausa de 3-7s entre queries (topsearch tem rate limit agressivo)
3. Processa cada candidato pelo pipeline padrão (filtros locais via bg)

**⚠ Importante**: NÃO transforma a palavra em hashtag. Busca direta via endpoint topsearch, que retorna perfis cujo @, nome ou bio combinam com a query.

### Source "engajamento em N posts de @perfil" (content.js)

Implementada em `collectProfilesFromEngagement(perfil, nPosts)`:
1. Resolve `@perfil` → user_id via `fetchProfileInfo`
2. Rejeita se perfil é privado (não dá pra ler posts)
3. Busca últimos N posts (clamp 1-12) via `fetchRecentPosts(userId, N)` — retorna `id` (media_id) pra usar nas chamadas seguintes
4. Para cada post:
   - `fetchPostLikers(mediaId)` — `/api/v1/media/<id>/likers/` retorna `{ users: [...] }` (até ~50 users)
   - `fetchPostCommenters(mediaId, maxPages=3)` — `/api/v1/media/<id>/comments/` paginado via `max_id` (até 3 páginas, ~60 comments por post). Pausa de 1.5-3.5s entre páginas
   - Dedupe via `seenUsernames` Set (inicia com o próprio dono pra excluir)
   - Acumula em `engagerList: [{ username, source: 'like'|'comment', is_private }]`
   - Pausa de 2-5s entre posts
5. Processa cada engajador único pelo pipeline padrão (mesmo flow de hashtag/seguidores):
   - Pacing entre perfis + pausas de grupo
   - `fetchProfileInfo` + `buildProfileData`
   - Envia `PROFILE_DATA` pro background

**⚠ Limitação conhecida**: os endpoints `/likers/` e `/comments/` têm rate limit mais agressivo que outras chamadas. N alto = mais risco de bloqueio.

### IG block state machine (anti-bot detection)

`content.js` reports IG fetch failures via `IG_FETCH_FAILED { status, body }`. `background.js`'s `igBlockDetector.classifyFailure()` classifies as `hard` (HTTP 429/403, known block strings) or `soft` (timeouts, 4xx generic).

Buffer de últimas 10 falhas em memória. `shouldTriggerBlock()` dispara quando:
- Qualquer single `hard` failure (1 ocorrência basta)
- 5+ consecutive `soft` failures

On trigger (`triggerBlockPause`):
1. Envia `STOP_COLLECTION` pro content.js
2. Incrementa `stats.bloqueio_count`
3. **Se count < 2**: seta `bloqueio_paused_until = now + 2h`, cria `chrome.alarms` `blockResume` no timestamp, broadcast `IG_BLOCK_PAUSED`
4. **Se count >= 2**: seta `bloqueio_definitivo = true`, broadcast `IG_BLOCK_DEFINITIVE`. User clica "Reiniciar Coleta" → `RESUME_PROSPECTING` pra começar de novo

On `blockResume` alarm: se não definitivo, seta `active = true`, broadcast `IG_BLOCK_RESUMED`, chama `runNextSource()` pra continuar da source/posição salva.

Popup mostra countdown ao vivo via `setInterval` (1s tick, `formatHMS`).

### Pacing (anti-detection delays)

`content.js` tem 3 camadas de randomização (aplicadas em hashtag E seguidores collection):
1. **Per-profile delay**: `randomInt(delayMinPerfil, delayMaxPerfil) * 1000ms` entre cada fetch de perfil
2. **Group pause**: a cada `tamanhoGrupo` perfis, pausa `randomInt(pausaMinGrupo, pausaMaxGrupo) * 1000ms`. **Tamanho do grupo varia ±20%** por grupo (via `irregularGroupSize()`) pra evitar padrão detectável
3. **Extra long pause**: a cada 3-5 grupos, pausa adicional de 2-5 minutos (`pacing.proximaPausaLonga` re-randomizada após cada uso)

### Storage schema (`db.js`)

All state lives in `chrome.storage.local`. Keys:

| Key | Type | Purpose |
|-----|------|---------|
| `isi_settings` | object | All user config — fontes, filtros, ICP/produto, OpenAI key, webhook, delays |
| `isi_profiles` | array | Approved profiles (with `score_local`, `score_breakdown`, optional messages) |
| `isi_stats` | object | See below — runtime counters, source iteration state, block state |
| `isi_log` | array | Last 100 log entries (no `message` field — reconstructed in UI) |
| `isi_blacklist` | object | `{ username: true }` — approved profiles, never re-processed |
| `isi_graylist` | object | `{ username: expiry_timestamp }` — rejected, ignored for 30 days |
| `isi_history` | array | All analyzed profiles (approved + rejected), max 500 |
| `device_uuid`, `license_key`, `license_status` | various | License module (see sync.js section) |

### `isi_stats` shape

```js
{
  // Runtime flags
  active: bool,
  processed, approved,             // counters

  // Telemetria
  descartados_local,               // perfis rejeitados pelos filtros locais
  aprovados_local,                 // perfis aprovados pelos filtros locais
  mensagens_geradas,               // perfis com mensagens geradas via OpenAI

  // Multi-source iteration
  sources: [                       // sources ativas (declarativo, imutável na sessão)
    { type: 'hashtag',        list: [...] },
    { type: 'seguidores',     perfil: 'x' },
    { type: 'engajamento',    perfil: 'x', nPosts: 12 },
    { type: 'palavras_chave', keywords: ['a', 'b'] },
  ],
  source_idx: 0,                   // índice da source em curso
  hashtag_idx: 0,                  // posição dentro do source de hashtag (quando aplicável)

  // State machine de bloqueio anti-bot
  bloqueio_count: 0|1|2,
  bloqueio_paused_until: timestamp_ms | null,
  bloqueio_definitivo: bool,
  bloqueio_last_reason: string,
}
```

### Profile schema (`isi_profiles[i]`)

```js
{
  id, status, coletado_em,         // metadata
  username, nome, url_perfil, bio, seguidores (formatted "12.3K"),
  seguidores_raw,                   // raw integer — used by filters
  data_ultimo_post,                 // timestamp ms — used by filters
  posts_recentes: [{ ts, likes, comentarios, eh_reel }],  // last 12
  engajamento_pct,                  // % média de (likes+comments)/followers
  ultimo_post_legenda, url_post_recente,

  // Score
  score_local,                      // 0-10 com 1 decimal
  score_breakdown,                  // { seguidores, recencia, frequencia, engajamento } 0-2 cada
  pontuacao_icp,                    // mirror de score_local pra compat com webhook antigo

  // Links da bio (usados pro contactExtractor)
  external_url,                     // string | null (formato legado)
  bio_links,                        // [{ url, title?, link_type? }, ...]

  // Contatos extraídos (Fase 5a — só preenchido se cfg.extrairContatos)
  contatos,                         // { emails, phones, whatsapps, grupos_whatsapp, has_contact }

  // Mensagens (opcionais — geradas sob demanda)
  mensagem_icebreaker, mensagem_hook, mensagem_gerada (= icebreaker),
  comentario_gerado, mensagens_geradas_em,

  // Status de ações
  webhook_status, webhook_error,
}
```

### Message types

**popup → background:**
- `START_PROSPECTING` / `STOP_PROSPECTING` / `RESUME_PROSPECTING`
- `START_LIST_PROSPECTING { usernames }`
- `GENERATE_MESSAGES { usernames: [] }` — gera ice/hook/comment via OpenAI
- `GET_PROFILES` / `GET_STATS` / `GET_HISTORY` / `GET_BLACKLIST` / `GET_GRAYLIST`
- `SEND_DM { username, message }` / `POST_COMMENT { username, postUrl, comment }` / `SEND_WEBHOOK { username }`
- `UPDATE_STATUS { username, status }` / `CLEAR_PROFILES`
- `CHECK_ACTIVE` (popup boot) / `CHECK_LICENSE`

**content → background:**
- `PROFILE_DATA { profileData }` — perfil coletado pronto pra pipeline
- `IG_FETCH_FAILED { status, body }` — falha de fetch pra classificador de bloqueio
- `COLLECTION_DONE` / `COLLECTION_ERROR { error }`
- `DM_SENT { username }` / `COMMENT_POSTED { username }`
- `PROGRESS { action, ... }` — log entries pro popup
- `PING` (health check)

**background → content:**
- `START_COLLECTION { hashtag }` — para hashtag source
- `START_FOLLOWERS_COLLECTION { perfil }` — para seguidores source
- `START_ENGAJAMENTO_COLLECTION { perfil, nPosts }` — para engajamento source
- `START_KEYWORDS_COLLECTION { keywords }` — para palavras-chave source
- `START_LIST_COLLECTION { usernames }` — triagem manual
- `STOP_COLLECTION`
- `SEND_DM { username, message }` / `POST_COMMENT { username, comment }`
- `PING`

**background → popup (broadcast):**
- `PROGRESS { action, ... }` — log + UI updates. Actions: `evaluating`, `local_approved`, `filter_reject`, `rejected`, `hashtag_start`, `hashtag_done`, `source_start`, `source_done`, `ig_block_paused`, `ig_block_definitive`, `ig_block_resumed`, `collection_done`, `collection_error`, `long_pause`, etc.
- `WEBHOOK_SENT` / `WEBHOOK_ERROR`
- `DM_SENT` / `COMMENT_POSTED`
- `LICENSE_REVOKED { license_status }`
- `IG_BLOCK_PAUSED { reason, until, message }` / `IG_BLOCK_DEFINITIVE { reason, message }` / `IG_BLOCK_RESUMED`
- `MESSAGES_GENERATING { username }` / `MESSAGES_GENERATED { username }` / `MESSAGES_FAILED { username, error }`

### Key implementation details

- **Service worker keep-alive**: alarm `keepAlive` every 24s (`periodInMinutes: 0.4`) previne Chrome de matar o SW entre batches
- **SW reliability**: `sendToBackground()` em `content.js` tem 120s timeout + 1 retry automático em SW restart. Todos os IG `fetch()` usam `fetchWithTimeout()` (15s) com `AbortController`
- **IG fetch failures**: content.js reporta todo non-200 (status + body) pro bg via `IG_FETCH_FAILED`. Bg classifica via `igBlockDetector` e decide se dispara pausa
- **Log entries**: `appendLog` em `background.js` salva `{ action, username, score, ... }` — sem `message`. `addLogEntry()` em `popup.js` reconstrói a mensagem humana pelos fields ao carregar do storage
- **ES Module cache**: `popup.html` carrega popup.js com `?v=N`. Incremente N após cada mudança em `popup.js` pra forçar Chrome a re-fetchar. Current: `?v=24`
- **Floating pill**: `content.js` injeta div fixed no canto superior direito da tab IG quando coletando, remove em stop/done/error
- **Bulk selection no popup**: cada card tem `.card-select` checkbox. `_selectedUsernames` Set rastreia seleção. Botão bulk "Gerar mensagens" habilitado só se count > 0 AND `_hasOpenAICached`
- **Sort/filter na lista de Aprovados**: `_listSortBy` (`score-desc` default | `date-desc` | `name-asc`) + `_listFilter` (`all` default | `with-msgs` | `without-msgs` | `dm-sent`). `applyListSortAndFilter` em `renderProfiles` antes de renderizar
- **Validação client-side**: `validateSearchConfig()` em `popup.js` valida fontes ativas antes de chamar `START_PROSPECTING` — checa formato de @perfil (regex `^[a-zA-Z0-9._]{1,30}$`), nPosts 1-12, keywords não-vazias
- **Telemetria visível**: stats-row no topo da aba Busca mostra 4 chips em tempo real (analisados, aprovados, descartados, mensagens). Update via `updateStatsUI({ processed, approved, descartados, mensagens })`
- **Export de histórico**: botão "↓ CSV" na aba Histórico chama `exportHistoryCsv()` que gera CSV com `data, username, nome, seguidores, pontuacao, resultado, motivo, detalhe (JSON serializado)`

### Filters (`filters.js`)

`passesFilters(profile, filters)` retorna `{ passed, reason?, detail? }`. Filtro não configurado = pulado. Dado ausente em filtro configurado = pulado (NÃO derruba o perfil). Quando reprovado, `detail` traz `{ actual, threshold, ... }` pra UI mostrar o porquê com valores reais (ex: "seguidores 500 < mín 1000"). As 5 dimensões:

| Dimensão | Source field | Politica |
|---|---|---|
| `seguidoresMin` / `seguidoresMax` | `profile.seguidores_raw` | Rejeita fora da faixa |
| `keywords` (CSV) | `nome + username + bio` | Match case+acento-insensitive, palavra inteira (regex `\b`); 1 match basta |
| `ultimoPostDiasMax` | `profile.data_ultimo_post` | Rejeita se última > X dias |
| `postsMin` + `postsDias` | `profile.posts_recentes` filtered by `ts > cutoff` | Rejeita se conta < min |
| `engajamentoMin` | `profile.engajamento_pct` | Rejeita se < min |

O `detail` é também salvo no `isi_history[i].motivo_detail` pra retro-visibilidade na aba Histórico.

### Score (`score.js`)

`calculateScore(profile, filters)` retorna `{ score: 0-10 (1 decimal), breakdown, dims_count }`. Cada dimensão contribui 0-2 pts; soma normalizada a 0-10 pelos filtros preenchidos (`score = soma * 10 / (dims_count * 2)`).

Lógica de pontuação por dimensão (quanto melhor o perfil dentro do filtro, mais pontos):
- **Seguidores**: linear de min (0 pts) a max (2 pts)
- **Recência**: hoje (2 pts) a dia X (0 pts)
- **Frequência**: mínimo M (0 pts) a 2×M+ (2 pts)
- **Engajamento**: mínimo E (0 pts) a 2×E+ (2 pts)
- **Keyword**: omitido (binário pra quem passa no filtro)

Edge case: nenhum filtro preenchido → score = 10 (sem base de comparação).

### Webhook payload (`webhook.js`)

Envia pra Supabase Edge Function. Field mappings principais:
- `origin` → sempre `'mineração'`
- `fit_score` → `Math.round(profile.score_local ?? profile.pontuacao_icp ?? 0)` (arredondado pra int)
- `temperature` → derivado do score: ≥9=quente, ≥7=morno, else frio
- `icebreaker_message` / `hook_message` / `suggested_comment` → mensagens, ou `undefined` se ausentes
- `has_messages` → `true` se ambos icebreaker E hook existirem; sempre incluso no payload (mesmo quando false)

### License module (`sync.js`)

License validation roda contra o endpoint isipanel `POST https://api.isitools.com.br/v1/license/validate`. O nome `sync` e funções (`__sync`, `__fp`, `__endpoint`) são intencionalmente inconspícuos — é anti-tampering cosmético; o JS é inspecionável.

- **HWID** = `SHA-256(device_uuid)` onde `device_uuid = crypto.randomUUID()` é gerado uma vez. Persiste em "Trocar chave"; só limpa em reinstall
- **Validação triggers**: (a) cada ação gated via `gateAction()` — force fresh fetch; (b) SW boot — `silent: true`, usa cache se fresh; (c) `chrome.alarms` `licenseCheck` a cada 360min; (d) botão "Revalidar"
- **Single-flight**: `_inflight` promise previne validações concorrentes
- **Cache**: armazena só responses `valid`. Qualquer non-valid **limpa o cache** imediatamente. Cache `grace_until` consultado **só** quando fetch falha com HTTP 5xx/timeout
- **Gated actions** (em `route()` em `background.js`): `START_PROSPECTING`, `START_LIST_PROSPECTING`, `SEND_DM`, `POST_COMMENT`, `SEND_WEBHOOK`, `GENERATE_MESSAGES`. PROFILE_DATA NÃO é gated
- **Revogação durante prospecção**: alarm/boot detecta non-valid → `__interruptOnRevocation` seta `stats.active=false`, envia `STOP_COLLECTION` pro content, broadcast `LICENSE_REVOKED`. Popup redireciona pra aba Licença

### Settings object shape

```js
{
  // Mensagens (geração on-demand)
  icp, produto, instrucaoAbordagem,
  openaiKey,                                  // opcional — sem isso, "Gerar mensagens" fica disabled
  promptIcebreaker, promptHook,               // customs opcionais

  // Fontes de busca (Busca tab)
  fonteHashtagAtiva, fonteHashtagLista,                                   // CSV até 10 hashtags
  fonteSeguidoresAtiva, fonteSeguidoresPerfil,
  fonteEngajamentoAtiva, fonteEngajamentoPerfil, fonteEngajamentoNPosts,  // 1-12 posts
  fontePalavrasChaveAtiva, fontePalavrasChaveLista,                       // até 10 termos CSV

  // Filtros pré-qualificação (Busca tab) — todos opcionais
  filtroSeguidoresMin, filtroSeguidoresMax,
  filtroKeywords,                             // CSV
  filtroUltimoPostDias,
  filtroPostsMin, filtroPostsDias,
  filtroEngajamentoMin,                       // %

  // Webhook (Webhook tab)
  webhookEndpoint, webhookApiKey,
  webhookFunnel, webhookStage, webhookTags,
  webhookAuto,

  // Anti-detecção (Avançado tab)
  delayMinPerfil, delayMaxPerfil,             // seconds entre perfis
  pausaMinGrupo, pausaMaxGrupo,               // seconds pra pausa de grupo
  tamanhoGrupo,                               // perfis por grupo (varia ±20% em runtime)

  // Extração de contatos (Avançado tab) — Fase 5a
  extrairContatos,                            // bool, default false

  // Compat retroativa (lido como fallback se fonteHashtagLista vazio)
  hashtags,                                   // CSV antigo
}
```
