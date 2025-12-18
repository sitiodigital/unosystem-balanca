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

console.log('Arquivos estáticos copiados com sucesso!');

