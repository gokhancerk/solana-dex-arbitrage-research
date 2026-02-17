1. PM2'nin Hafızasını Komple Sil
Eski ayarları kökünden kazımak için botu PM2'den tamamen siliyoruz:
pm2 delete arb-server

2. Botu Sıfırdan Tekrar Ekliyoruz
Şimdi .env dosyasını taze taze, en baştan okuması için botu PM2'ye tekrar ekle. (Eğer npm run start ile başlatıyorsan komutun şu şekildedir):
pm2 start npm --name "arb-server" -- run start
