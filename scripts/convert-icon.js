const fs = require('fs');
const path = require('path');

// Verificar se o arquivo PNG existe
const pngPath = path.join(__dirname, '../assets/512x512.png');
const icoPath = path.join(__dirname, '../assets/icon.ico');

if (!fs.existsSync(pngPath)) {
  console.error('❌ Arquivo PNG não encontrado:', pngPath);
  process.exit(1);
}

// Tentar usar sharp e to-ico
let sharp, toIco;
try {
  sharp = require('sharp');
  toIco = require('to-ico');
} catch (e) {
  console.log('⚠️  Dependências não encontradas.');
  console.log('💡 Execute: pnpm install');
  console.log('💡 Ou crie manualmente um arquivo icon.ico válido a partir de 512x512.png');
  process.exit(1);
}

async function convertPngToIco() {
  try {
    console.log('🔄 Convertendo PNG para ICO...');
    
    // Criar múltiplos tamanhos para o ICO (16, 32, 48, 256)
    const sizes = [16, 32, 48, 256];
    const buffers = [];
    
    for (const size of sizes) {
      const buffer = await sharp(pngPath)
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      buffers.push(buffer);
    }
    
    // Converter para ICO
    const icoBuffer = await toIco(buffers);
    fs.writeFileSync(icoPath, icoBuffer);
    
    console.log('✅ Ícone ICO criado com sucesso:', icoPath);
  } catch (error) {
    console.error('❌ Erro ao converter PNG para ICO:', error.message);
    console.log('\n💡 Alternativa: Use uma ferramenta online ou local para converter 512x512.png em icon.ico');
    console.log('   Recomendado: https://convertio.co/png-ico/ ou ImageMagick');
    process.exit(1);
  }
}

convertPngToIco();

