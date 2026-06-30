const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, '../unosystem.svg');
const assetsDir = path.join(__dirname, '../assets');
const pngPath = path.join(assetsDir, '512x512.png');
const icoPath = path.join(assetsDir, 'icon.ico');

if (!fs.existsSync(svgPath)) {
  console.error('❌ Arquivo SVG não encontrado:', svgPath);
  process.exit(1);
}

let sharp, toIco;
try {
  sharp = require('sharp');
  toIco = require('to-ico');
} catch (e) {
  console.error('❌ Dependências não encontradas. Execute: pnpm install');
  process.exit(1);
}

async function generateIcons() {
  fs.mkdirSync(assetsDir, { recursive: true });

  console.log('🔄 Gerando ícones a partir de unosystem.svg...');

  await sharp(svgPath).resize(512, 512).png().toFile(pngPath);
  console.log('✅ PNG 512x512:', pngPath);

  const sizes = [16, 32, 48, 256];
  const buffers = await Promise.all(
    sizes.map((size) =>
      sharp(svgPath).resize(size, size).png().toBuffer(),
    ),
  );

  const icoBuffer = await toIco(buffers);
  fs.writeFileSync(icoPath, icoBuffer);
  console.log('✅ ICO:', icoPath);
}

generateIcons().catch((error) => {
  console.error('❌ Erro ao gerar ícones:', error.message);
  process.exit(1);
});
