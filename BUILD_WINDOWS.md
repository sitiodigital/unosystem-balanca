# Build para Windows

## ⚠️ Limitação: Cross-compilation do macOS para Windows

O `serialport` é um módulo nativo que precisa ser compilado para cada plataforma. O `node-gyp` **não suporta cross-compilation** (compilar para Windows a partir do macOS).

## Soluções

### Opção 1: Build em uma máquina Windows (Recomendado)

A forma mais confiável é fazer o build diretamente em uma máquina Windows:

```bash
# Na máquina Windows
pnpm install
pnpm run build:win
```

### Opção 2: Usar binários pré-compilados (Pode funcionar)

O `electron-builder` tentará usar binários pré-compilados do npm. Execute:

```bash
npm_config_build_from_source=false pnpm run build:win
```

**Nota**: Isso pode não funcionar se os binários pré-compilados não estiverem disponíveis para a versão específica do Electron.

### Opção 3: Usar GitHub Actions ou CI/CD

Configure um workflow do GitHub Actions para fazer o build automaticamente em uma máquina Windows virtual.

## Scripts disponíveis

- `pnpm run build:win` - Build para Windows (tenta usar binários pré-compilados)
- `pnpm run build:win:local` - Build para Windows (sem preparação adicional)

