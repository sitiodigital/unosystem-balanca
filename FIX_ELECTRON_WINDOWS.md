# Como Corrigir o Erro do Electron no Windows

Se você está recebendo o erro:
```
Error: Electron failed to install correctly, please delete node_modules/electron and try installing again
```

## Solução Rápida

Execute os seguintes comandos **na ordem**:

```bash
# 1. Remover node_modules e lock file
Remove-Item -Recurse -Force node_modules
Remove-Item pnpm-lock.yaml

# 2. Limpar cache do pnpm
pnpm store prune

# 3. Reinstalar tudo
pnpm install

# 4. Verificar se o Electron foi instalado
pnpm exec electron --version
```

Se o passo 4 mostrar a versão do Electron, está funcionando! Caso contrário, continue:

## Solução Alternativa (se a rápida não funcionar)

```bash
# 1. Remover apenas o Electron
pnpm remove electron

# 2. Limpar cache específico do Electron
pnpm store prune

# 3. Reinstalar Electron com variáveis de ambiente específicas
$env:npm_config_cache = $null
pnpm add -D electron@^39.2.7 --force

# 4. Verificar instalação
pnpm exec electron --version
```

## Solução Manual (último recurso)

1. Feche todos os processos relacionados ao Node.js/Electron
2. Delete manualmente a pasta `node_modules\.pnpm\electron@39.2.7`
3. Execute `pnpm install` novamente
4. Aguarde o download completo dos binários do Electron (pode demorar alguns minutos)

## Verificar Instalação

Após reinstalar, teste se funciona:

```bash
pnpm run build
pnpm exec electron --version
```

Se ambos funcionarem, você pode executar:

```bash
pnpm run dev
```

## Causas Comuns

- **Instalação interrompida**: O download dos binários foi interrompido
- **Permissões**: Problemas de permissão no Windows
- **Antivírus**: Alguns antivírus bloqueiam a instalação de binários
- **Cache corrompido**: Cache do pnpm corrompido

## Se Nada Funcionar

Tente usar npm ao invés de pnpm temporariamente:

```bash
npm install
npm run dev
```

