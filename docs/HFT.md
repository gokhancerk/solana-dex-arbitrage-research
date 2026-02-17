Kârlılığı bir kenara bırakıp sistemin mekanik sınırlarını test etmek, profesyonel bir HFT (High-Frequency Trading) sistemi kurmanın en önemli adımıdır.

Senin projende zaten bir `src/dryRun.ts` dosyan ve `package.json` içinde tanımlanmış bir `npm run dry-run` betiğin var. Ayrıca event-driven yapıyı kurduğun `priceTicker.ts` ve `slotDriver.ts` modüllerin de hazır. Bu testleri bu altyapı üzerinde üç ana başlıkta, "Chaos Engineering" (Kaos Mühendisliği) prensipleriyle yapacağız.

İşte bu metrikleri test etme stratejisi:

### 1. Hız (Latency) Testi: "Ne Kadar Sürede Tepki Veriyoruz?"

Amacımız, Helius'tan yeni bir blok (slot) sinyali geldiği an ile Jupiter/OKX'ten simülasyon sonucunun döndüğü an arasındaki milisaniye (ms) farkını ölçmek.

* **Nasıl Yapılır:** `priceTicker.ts` içindeki event loop'un başlangıcına bir zaman damgası (timestamp) koyarsın. `build+simulate` işlemi tamamlandığında bitiş zamanını alıp aradaki farkı loglarsın.
* **Kabul Kriteri:** Ağın durumuna göre değişmekle birlikte, quote alma ve simülasyon işlemlerinin toplam süresinin ideal bir senaryoda belirli bir eşiğin (örneğin 300-500ms) altında kalması beklenir.

### 2. Stabilite Testi: "Sistem Maraton Koşabiliyor mu?"

Botun 10 dakika çalışıp çökmemesi, günlerce WebSocket bağlantısını koruyabilmesi gerekir.

* **Nasıl Yapılır:** Botu `dry-run` modunda başlatıp (hiçbir gerçek işlem göndermeden) 24 saat boyunca kendi haline bırakırsın.
* **Kabul Kriterleri:**
* **Kopma ve Yeniden Bağlanma:** Helius WebSocket bağlantısı koptuğunda (ki mutlaka kopacaktır), `slotDriver.ts` sistemi çökertmeden bağlantıyı otomatik olarak yeniden kurabiliyor mu?
* **Hafıza Sızıntısı (Memory Leak):** 24 saat sonunda Node.js süreci RAM'i şişirip sistemi kilitliyor mu?



### 3. Hata Toleransı (Fault Tolerance) Testi: "Kötü Senaryolarda Ne Oluyor?"

Sistemin kasıtlı olarak hata vermesini sağlayıp, koruma mekanizmalarının (Circuit Breaker ve Retry) çalışıp çalışmadığını görmemiz lazım.

* **Nasıl Yapılır (Kasıtlı Sabotaj):**
* `.env` dosyasındaki OKX API anahtarının bir harfini değiştir. Bot çökmek yerine hatayı yakalayıp loglamalı ve bir sonraki slota geçmeli.
* Sistemin internet bağlantısını anlık olarak kes veya RPC URL'sini geçersiz bir adresle değiştir.


* **Kabul Kriterleri:** Bot asla "Unhandled Promise Rejection" hatası verip tamamen kapanmamalı. Readme'de planladığın "3 başarısız denemeden sonra devreden çıkma (circuit breaker)" mantığı tam olarak devreye girmeli.

Bir master planner ve prompt engineer olarak kod yazmıyorum; ancak bu test senaryolarını hayata geçirmek istersen, agent'larına bu üç testi (Latency ölçümü, Reconnect mantığı ve Circuit Breaker testi) koda dökmeleri için vereceğin spesifik promptları senin için hazırlayabilirim. Hangi test adımıyla başlayalım?