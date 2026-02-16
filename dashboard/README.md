# Arbitraj Dashboard

SOL/USDC arbitraj botunun ürettiği `trades.jsonl` verilerini görselleştiren React dashboard.

## Teknolojiler

- **React 19** + **TypeScript** + **Vite**
- **Tailwind CSS v4** + **shadcn/ui**
- **Recharts** (grafik)

## Kurulum

```bash
cd dashboard
npm install
```

## Başlatma

### 1. Backend API'yi başlat (ayrı terminal)

```bash
# Proje kök dizininden
npm run server
# → http://localhost:3001/api/logs
```

### 2. Dashboard'u başlat

```bash
# Proje kök dizininden
npm run dashboard
# → http://localhost:5173

# veya dashboard klasöründen
cd dashboard && npm run dev
```

## API Endpoint

Dashboard varsayılan olarak `http://localhost:3001` adresine bağlanır.
Farklı bir adres kullanmak için `.env` dosyası oluşturun:

```env
VITE_API_URL=http://localhost:3001
```

## Üretim Build

```bash
npm run dashboard:build
# Çıktı: dashboard/dist/
```

`dist/` klasörü statik olarak herhangi bir sunucudan servis edilebilir.

## Özellikler

| Bileşen | Açıklama |
|---------|----------|
| **İstatistik Kartları** | Toplam fırsat, winrate, potansiyel net kâr |
| **Spread Grafiği** | Saatlik brüt/net spread dağılımı (UTC) |
| **İşlem Tablosu** | Tüm işlemlerin detaylı listesi (tarih, parite, yön, brüt/net kâr, durum) |
| **Otomatik Yenileme** | Her 15 saniyede API'den güncel veri çeker |
| **Retry Mekanizması** | Başarısız fetch'lerde üstel geri çekilme ile yeniden dener |
