# VPS Deployment Rehberi

Bu belge, projenin bir VPS (Virtual Private Server) üzerinde kurulumu, yapılandırılması ve PM2 ile çalıştırılmasını kapsar.

---

## 1. Ön Koşullar

| Gereksinim | Minimum |
|---|---|
| OS | Debian / Ubuntu (x64) |
| Node.js | v20+ (nvm ile kurulum önerilir) |
| npm | v10+ |
| PM2 | v6+ (global) |
| RAM | 512 MB |
| Disk | 1 GB boş alan |

---

## 2. Sunucuya Bağlanma

```bash
ssh -p 5849 gkhn@72.60.37.142
```

---

## 3. Node.js Kurulumu (nvm)

```bash
# nvm kur
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# Shell'i yenile
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Node 20 kur ve varsayılan yap
nvm install 20
nvm alias default 20

# Doğrula
node -v   # v20.x.x
npm -v    # 10.x.x
```

> **Not:** Non-interactive shell'lerde (SSH komutları, PM2) nvm otomatik yüklenmez. PATH'e doğrudan eklenmesi gerekir:
> ```bash
> export PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH
> ```

---

## 4. PM2 Kurulumu

```bash
npm install -g pm2
pm2 --version   # 6.x.x
```

---

## 5. Projeyi Klonlama

```bash
cd ~
git clone git@github.com:gokhancerk/Dex-Arbitrage-Bot.git
cd Dex-Arbitrage-Bot
```

---

## 6. Bağımlılıkları Kurma

```bash
# Backend bağımlılıkları
npm install

# Dashboard bağımlılıkları
cd dashboard && npm install && cd ..
```

---

## 7. Dashboard Build

React dashboard'u statik dosyalara derlenir, Express sunucusu tarafından `dashboard/dist/` klasöründen sunulur.

```bash
npm run dashboard:build
```

Build çıktısı:
```
dashboard/dist/
├── assets/
│   ├── index-xxxxx.css   (~34 KB)
│   └── index-xxxxx.js    (~627 KB)
├── index.html
└── vite.svg
```

---

## 8. Ortam Değişkenlerini Ayarlama

`.env` dosyasını proje kök dizinine oluştur veya local'den kopyala:

```bash
# Local'den SCP ile kopyalama (local bilgisayardan):
scp -P 5849 .env gkhn@72.60.37.142:~/Dex-Arbitrage-Bot/.env
```

Gerekli `.env` değişkenleri için bkz. [setup.md](setup.md).

### Dashboard Şifresi

Dashboard'a erişimi korumak için `.env`'e ekle:

```dotenv
DASHBOARD_PASSWORD=güçlü_bir_şifre
```

Tanımlı değilse dashboard korumasız açılır.

---

## 9. Gerekli Klasörler

```bash
mkdir -p logs .key
```

| Klasör | Amaç |
|---|---|
| `logs/` | `trades.jsonl` telemetri dosyası, PM2 log dosyaları |
| `.key/` | `keypair.json` Solana cüzdan dosyası |

---

## 10. PM2 ile Çalıştırma

### Başlatma

```bash
pm2 start ecosystem.config.cjs
```

### ecosystem.config.cjs

```javascript
module.exports = {
  apps: [
    {
      name: "arb-server",
      script: "npx",
      args: "tsx src/server.ts",
      cwd: "./",
      env: { NODE_ENV: "production" },
      max_restarts: 10,
      restart_delay: 3000,
      exp_backoff_restart_delay: 1000,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/pm2-error.log",
      out_file: "logs/pm2-out.log",
      merge_logs: true,
    },
  ],
};
```

### PM2 Komutları

| Komut | Açıklama |
|---|---|
| `pm2 status` | Tüm süreçlerin durumunu göster |
| `pm2 logs arb-server` | Canlı log akışı |
| `pm2 logs arb-server --lines 50` | Son 50 satır log |
| `pm2 restart arb-server` | Yeniden başlat |
| `pm2 stop arb-server` | Durdur |
| `pm2 delete arb-server` | Süreç listesinden kaldır |
| `pm2 save` | Mevcut süreç listesini kaydet |
| `pm2 monit` | Terminal tabanlı monitoring UI |

### Reboot Sonrası Otomatik Başlatma

```bash
pm2 save
pm2 startup
# PM2 bir sudo komutu verecek — onu kopyalayıp çalıştır:
sudo env PATH=$PATH:/home/gkhn/.nvm/versions/node/v20.20.0/bin \
  /home/gkhn/.nvm/versions/node/v20.20.0/lib/node_modules/pm2/bin/pm2 \
  startup systemd -u gkhn --hp /home/gkhn
```

---

## 11. Erişim ve Portlar

| Servis | URL | Port |
|---|---|---|
| Dashboard (React SPA) | `http://<VPS_IP>:3001/` | 3001 |
| API (trade logs) | `http://<VPS_IP>:3001/api/logs` | 3001 |

Port değiştirmek için `.env`'de:
```dotenv
API_PORT=8080
```

---

## 12. Güncelleme Akışı

VPS üzerinde projeyi güncellemek için:

```bash
cd ~/Dex-Arbitrage-Bot

# 1) Kodu çek
git pull

# 2) Bağımlılık değişikliği varsa
npm install

# 3) Dashboard değişikliği varsa
npm run dashboard:build

# 4) Sunucuyu yeniden başlat
pm2 restart arb-server
```

---

## 13. Log Dosyaları

| Dosya | İçerik |
|---|---|
| `logs/trades.jsonl` | Telemetri kayıtları (JSONL formatı) |
| `logs/pm2-out.log` | PM2 stdout logları |
| `logs/pm2-error.log` | PM2 stderr logları |

Log dosyalarını temizlemek:
```bash
pm2 flush arb-server          # PM2 loglarını temizle
> logs/trades.jsonl            # Telemetri dosyasını sıfırla
```

---

## 14. Sorun Giderme

| Sorun | Çözüm |
|---|---|
| `pm2: command not found` | `export PATH=$HOME/.nvm/versions/node/v20.20.0/bin:$PATH` |
| Dashboard 404 | `npm run dashboard:build` ile build al |
| API 401 Unauthorized | `.env`'deki `DASHBOARD_PASSWORD` ile giriş yap |
| Port zaten kullanılıyor | `lsof -i :3001` ile kontrol et, `kill <PID>` |
| PM2 restart loop | `pm2 logs arb-server --lines 30` ile hatayı incele |
| `.env` değişmedi | `pm2 restart arb-server` ile yeniden başlat |
| `EBADENGINE` uyarıları | Node 20'ye yükselt: `nvm install 20 && nvm alias default 20` |
