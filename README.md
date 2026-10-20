# Korea Car Marketplace — Direct Sale + 72 soatlik Live Auction

Bitta foydalanuvchi hisobi va umumiy backend (Supabase/Postgres), ikkita mustaqil bo'lim:
- **Direct Sale** — belgilangan narx, narx taklifi (kelishuv), "sotib olishni boshlash", sotuvchi tasdiqlaydi, sotilgach e'lon yopiladi.
- **Auction** — 72 soat, server vaqti, real vaqtga yaqin yangilanish, anti-sniping, rezerv narx, shartli g'olib, qayta auksion qoidalari.

Bitta avtomobil bir vaqtda faqat bitta ochiq e'londa bo'ladi — bu bazada **unique index** bilan majburlanadi.

## Arxitektura
Barcha qoidalar serverda — `supabase/migrations/*.sql` (Postgres funksiyalari, `security definer`). Interfeys faqat RPC chaqiradi; jadvallarga to'g'ridan-to'g'ri yozish yopiq (RLS + grant).

| Fayl | Mazmuni |
|---|---|
| `…0100_schema.sql` | jadvallar; pul — butun son (minor units) |
| `…0200_functions.sql` | `place_bid`, `create_auction`, `finalize_*`, sotuv, depozit, admin amallari |
| `…0300_security.sql` | RLS, ustun darajasidagi ruxsatlar, ommaviy view'lar, o'zgarmas stavka/audit triggerlari |
| `…0400_realtime_cron.sql` | Realtime publikatsiya, `pg_cron` (har daqiqa yakunlash) |
| `…0500_kyc_storage.sql` | shaxs hujjatlari uchun yopiq bucket |
| `supabase/functions/payment-webhook` | imzosi tekshiriladigan to'lov webhook'i (provayder hali yo'q → 503) |
| `src/` | React interfeysi (uz/ru/ky) |

### Asosiy qoidalar
- Stavka: 100–6 000 USD (butun dollar), serverda tekshiriladi; admin oraliqni faqat toraytira oladi.
- Boshlang'ich narx (sotuvchi), rezerv narx (sotuvchi, yashirin), oshirish qadami (admin) — alohida.
- Concurrency: `place_bid` auksion qatorini `FOR UPDATE` bilan qulflaydi, vaqtni qulfdan keyin `clock_timestamp()` bilan oladi; bir xil summada ikkita haqiqiy stavka bo'lmasligi unique index bilan ham himoyalangan.
- Firibgarlikka qarshi: o'z avtomobiliga stavka yo'q, o'z stavkasini o'zi oshirish yo'q, tasdiqlanmagan/bloklangan hisob stavka bera olmaydi, daqiqasiga limit, eng yuqori stavkachi va rezerv boshqalarga ko'rinmaydi, admin stavkani faqat sababi bilan bekor qiladi.
- Anti-sniping: oxirgi `anti_snipe_window` (2 daqiqa) ichida stavka → `ends_at = max(ends_at, hozir + anti_snipe_extend)`, har stavkada takrorlanadi, admin sozlaydi.
- Valyuta: stavka USD sentda; avtomobil valyutasidagi qiymat aniq `numeric` bilan hisoblanadi, kurs snapshot bilan saqlanadi; kurs eskirgan bo'lsa stavka rad.

## Ishga tushirish
```bash
npm install
npm test          # kutubxona testlari
npm run test:db   # baza testlari (PostgreSQL avtomatik yuklab olinadi, Docker shart emas)
cp .env.example .env   # Supabase URL va anon kalit
npm run dev
```
Supabase'ga qo'llash: migratsiyalarni tartib bilan (`supabase db push` yoki SQL Editor), so'ng admin qilish:
`update public.profiles set role='admin', verification='verified' where id = '<uid>';` (SQL Editor'da, egasi sifatida).

Test natijalari va **tayyor bo'lmagan qismlar**: [TESTLAR.md](TESTLAR.md).
