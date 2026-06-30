const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, '../unosystem.svg');
const assetsDir = path.join(__dirname, '../assets');
const pngPath = path.join(assetsDir, '512x512.png');
const png256Path = path.join(assetsDir, '256x256.png');
const icoPath = path.join(assetsDir, 'icon.ico');

/** Tamanhos padrão Windows 10/11 para .ico (máx. 256 no formato ICO) */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** DPI alto na rasterização SVG → bordas nítidas ao reduzir */
const SVG_DENSITY = 384;

/** Master interno antes do downscale (supersampling) */
const MASTER_SIZE = 1024;

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

async function createMasterBuffer() {
  return sharp(svgPath, { density: SVG_DENSITY })
    .resize(MASTER_SIZE, MASTER_SIZE, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

async function resizeFromMaster(master, size) {
  return sharp(master)
    .resize(size, size, {
      kernel: sharp.kernel.lanczos3,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

async function generateIcons() {
  fs.mkdirSync(assetsDir, { recursive: true });

  console.log('🔄 Gerando ícones a partir de unosystem.svg (supersampling)...');

  const master = await createMasterBuffer();

  await sharp(master).resize(512, 512).png().toFile(pngPath);
  console.log('✅ PNG 512x512:', pngPath);

  await sharp(master).resize(256, 256).png().toFile(png256Path);
  console.log('✅ PNG 256x256:', png256Path);

  const buffers = await Promise.all(
    ICO_SIZES.map((size) => resizeFromMaster(master, size)),
  );

  const icoBuffer = await toIco(buffers);
  fs.writeFileSync(icoPath, icoBuffer);
  console.log('✅ ICO (' + ICO_SIZES.join(', ') + '):', icoPath);

  // Pré-visualização dos tamanhos pequenos (útil no Mac)
  const previewDir = path.join(assetsDir, 'preview');
  fs.mkdirSync(previewDir, { recursive: true });
  for (const size of [16, 32, 48, 256]) {
    const idx = ICO_SIZES.indexOf(size);
    const previewPath = path.join(previewDir, `${size}x${size}.png`);
    await sharp(buffers[idx]).toFile(previewPath);
  }
  console.log('✅ Pré-visualização:', previewDir);
}

generateIcons().catch((error) => {
  console.error('❌ Erro ao gerar ícones:', error.message);
  process.exit(1);
});
