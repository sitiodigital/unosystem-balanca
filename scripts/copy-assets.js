const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../src/renderer');
const distDir = path.join(__dirname, '../dist/renderer');

// Criar diretório dist/renderer se não existir
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Arquivos para copiar
const filesToCopy = ['index.html', 'styles.css'];

filesToCopy.forEach((file) => {
  const srcFile = path.join(srcDir, file);
  const distFile = path.join(distDir, file);
  
  if (fs.existsSync(srcFile)) {
    fs.copyFileSync(srcFile, distFile);
    console.log(`Copiado: ${file}`);
  } else {
    console.warn(`Arquivo não encontrado: ${srcFile}`);
  }
});

// Remover logo antiga se ainda existir no dist
const legacyLogo = path.join(distDir, 'logo.png');
if (fs.existsSync(legacyLogo)) {
  fs.unlinkSync(legacyLogo);
  console.log('Removido: logo.png (legado)');
}

// Copiar logo oficial (fonte única na raiz do projeto)
const svgSource = path.join(__dirname, '../unosystem.svg');
const svgDest = path.join(distDir, 'unosystem.svg');
if (fs.existsSync(svgSource)) {
  fs.copyFileSync(svgSource, svgDest);
  console.log('Copiado: unosystem.svg');
} else {
  console.warn('Arquivo não encontrado:', svgSource);
}

// Copiar arquivos de imagem do renderer (exceto logos antigas)
const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
if (fs.existsSync(srcDir)) {
  const files = fs.readdirSync(srcDir);
  files.forEach((file) => {
    const ext = path.extname(file).toLowerCase();
    if (imageExtensions.includes(ext) && file !== 'logo.png') {
      const srcFile = path.join(srcDir, file);
      const distFile = path.join(distDir, file);
      fs.copyFileSync(srcFile, distFile);
      console.log(`Copiado: ${file}`);
    }
  });
}

// Remover exports do renderer.js (CommonJS não funciona no browser)
const rendererJsPath = path.join(distDir, 'renderer.js');
if (fs.existsSync(rendererJsPath)) {
  let content = fs.readFileSync(rendererJsPath, 'utf8');
  // Remove linhas que definem exports (CommonJS)
  content = content.replace(/^"use strict";\s*\n?/, '');
  content = content.replace(/Object\.defineProperty\(exports,\s*"__esModule",\s*\{\s*value:\s*true\s*\}\);\s*\n?/g, '');
  content = content.replace(/exports\.\w+\s*=\s*[^;]+;\s*\n?/g, '');
  fs.writeFileSync(rendererJsPath, content, 'utf8');
  console.log('Limpeza de exports do renderer.js concluída');
}

console.log('Arquivos estáticos copiados com sucesso!');

