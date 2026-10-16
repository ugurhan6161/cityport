const fs = require('node:fs');
const path = require('node:path');

const outputDirectory = path.join(__dirname, 'public');
const staticFiles = [
  'index.html',
  'app.js',
  'manifest.json',
  'responsive.css',
  'styles.css',
];

console.log('[build] Başlıyor, çıktı klasörü:', outputDirectory);

// Eski çıktıyı temizle ve klasörü yeniden oluştur
fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true });

for (const file of staticFiles) {
  const source = path.join(__dirname, file);
  const target = path.join(outputDirectory, file);

  if (!fs.existsSync(source)) {
    console.error(`[build] HATA: "${file}" bulunamadı. Dosya repoya commit edilmiş mi?`);
    process.exit(1);
  }

  fs.copyFileSync(source, target);
  console.log(`[build] Kopyalandı: ${file}`);
}

if (!fs.existsSync(path.join(outputDirectory, 'index.html'))) {
  console.error('[build] HATA: public/index.html oluşmadı.');
  process.exit(1);
}

console.log('[build] Tamamlandı.');