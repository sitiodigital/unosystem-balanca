# UnoSystem Balança

Aplicação desktop Electron para configuração e comunicação com balança via porta serial, integrada ao sistema UnoSystem.

Repositório: [github.com/sitiodigital/unosystem-balanca](https://github.com/sitiodigital/unosystem-balanca)

## Requisitos

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 10+
- Windows x64 (build e distribuição principal)

## Instalação

```bash
pnpm install
```

## Desenvolvimento

```bash
pnpm dev
```

Compila TypeScript, observa alterações em `src/` e reinicia o Electron automaticamente.

```bash
pnpm build    # compila sem abrir o app
pnpm start    # build + electron
```

> O auto-update **não funciona** em modo desenvolvimento — apenas no aplicativo instalado.

## Build local (Windows)

Gera o instalador em `dist_electron/` sem publicar no GitHub:

```bash
pnpm build:win:local
```

## Publicar release

As releases são publicadas automaticamente via **GitHub Actions** ao enviar uma tag `v*`.

### 1. Atualize a versão

Edite o campo `version` em `package.json` (ex.: `1.0.8`).

### 2. Commit e tag

```bash
git add .
git commit -m "chore: release 1.0.7"
git tag v1.0.7
git push origin main
git push origin v1.0.7
```

Substitua `1.0.7` / `v1.0.7` pela versão desejada. A tag deve corresponder à versão do `package.json`.

### 3. Acompanhe o workflow

Em **Actions** no GitHub, o job `Release` builda no Windows e publica em [Releases](https://github.com/sitiodigital/unosystem-balanca/releases) os arquivos:

- `UnoSystem Setup X.Y.Z.exe` — instalador
- `latest.yml` — metadados para auto-update
- `*.blockmap` — update diferencial (quando aplicável)

### Publicação manual (alternativa)

Em uma máquina Windows, com token de acesso ao GitHub:

```bash
GH_TOKEN=seu_token pnpm run release:win
```

Crie o token em [github.com/settings/tokens](https://github.com/settings/tokens) com escopo `public_repo`. **Nunca** commite o token no repositório.

## Auto-update

O aplicativo verifica atualizações:

- automaticamente ao abrir (após ~5 segundos) e a cada 4 horas;
- manualmente pelo botão **Verificar atualizações** na tela de configuração.

Quando há nova versão, o usuário clica em **Atualizar**, acompanha o progresso do download e reinicia para concluir a instalação.

### Testar o fluxo de update

1. Publique e instale a versão base (ex.: `v1.0.7`).
2. Publique uma versão superior (ex.: `v1.0.8`).
3. Abra o app instalado na versão antiga e use **Verificar atualizações**.

### Logs

Logs do updater ficam em:

- **Windows:** `%APPDATA%\UnoSystem\logs\main.log`

## Scripts úteis

| Comando | Descrição |
|---------|-----------|
| `pnpm dev` | Modo desenvolvimento com hot reload |
| `pnpm build` | Compila TypeScript e copia assets |
| `pnpm generate:icons` | Gera ícones a partir de `unosystem.svg` |
| `pnpm build:win:local` | Instalador Windows local |
| `pnpm release:win` | Build + publica no GitHub Releases |
| `pnpm clear-storage` | Limpa configurações salvas localmente |

## Identidade visual

A logo e os ícones da aplicação são derivados de `unosystem.svg` na raiz do projeto. Os arquivos em `assets/` (`512x512.png`, `icon.ico`) são gerados automaticamente pelo script `generate-icons.js`.

## Estrutura

```
src/
  main.ts                 # Processo principal Electron
  preload.ts              # Bridge segura para o renderer
  updater/                # Auto-update (electron-updater)
  renderer/                 # Tela de configuração (HTML/CSS/TS)
unosystem.svg               # Logo oficial (fonte única)
.github/workflows/release.yml  # CI de release Windows
```

## Licença

ISC
