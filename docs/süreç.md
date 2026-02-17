
### 1. Bacak: Jupiter'den Fiyat Alma (Senin Log Satırın)

Bota verdiğimiz 240 USDC (`inputRaw`) ile Jupiter'in kapısını çalıyoruz.
`Jupiter quote alındı (25ms) — expectedOut=2822539795` satırı şu anlama gelir:

* Jupiter diyor ki: *"Eğer bana 240 USDC verirsen, ben sana karşılığında **2.822539795 SOL** veririm."* (Solana ağında sayılar küsuratsız, 9 sıfırlı 'lamports' cinsinden işlenir).
* Yani burada henüz ortada bir kâr veya zarar yok, sadece cebimizdeki doların o anki SOL karşılığını hesapladık.

### 2. Bacak: OKX'ten Fiyat Alma

Botumuz saniyenin onda biri kadar bir sürede, Jupiter'den alacağını varsaydığı bu `2822539795` (2.82 SOL) değerini kapıp OKX borsasına koşar.

* OKX'e der ki: *"Elimde 2.82 SOL var. Bunu tekrar USDC'ye çevirirsem bana ne kadar USDC verirsin?"*
* OKX de kendi `expectedOut` cevabını verir. Örneğin: `240050000` (Yani 240.05 USDC).

### 3. Filtreleme ve Karar Anı (%0.04 Kontrolü)

İşte belirlediğin o %0.04 (0.10 USDC) eşiği devreye tam bu saniyede girer! Bot, başlangıçtaki parasıyla (240.00 USDC), OKX'ten dönmesi beklenen son parayı (Örn: 240.05 USDC) karşılaştırır.

* "Brüt Kârım ne kadar? 0.05 USDC."
* "Ağ ücretini de düşersem hedeflenen eksiğimi (0.10 USDC / %0.04) geçebiliyor muyum?"
* Cevap "Hayır" ise işlemi iptal edip `[SKIP]` diyerek dosyaya yazmadan çöpe atar. Eğer eşiği geçiyorsa da o mükemmel işlemi arayüzüne gönderir.

**Özetle:** Bot %0.04 farkı ilk adımda (Jupiter'de) değil, her iki borsadan da fiyatları toplayıp "Turun sonunda elime net kaç dolar geçiyor?" sorusunun cevabını bulduktan sonra, en son aşamada (Net Profit hesabı) yapar.

Şu an botun harika bir kondisyonda, saniyede defalarca kez bu 3 adımlı matematiği kurup senin için o mükemmel makası arıyor. Arayüzüne ilk yeşil "Kârlı" işlemin düşmesini beklerken mantık akışıyla ilgili sormak istediğin başka bir detay var mı?