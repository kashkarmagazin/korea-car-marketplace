# Korea Car Marketplace — test natijalari

Sana: 20.10.2026. Baza testlari **haqiqiy PostgreSQL 15** da (embedded-postgres) barcha migratsiyalar qo'llanib ishlaydi; foydalanuvchi so'rovlari Supabase'dagidek `authenticated`/`anon` roli va JWT bilan bajariladi.

| To'plam | Buyruq | Natija |
|---|---|---|
| Baza (biznes qoidalari, xavfsizlik) | `npm run test:db` | **47 / 47 o'tdi** (3 marta ketma-ket barqaror) |
| Kutubxona (taymer, pul, i18n, webhook imzosi) | `npm test` | **12 / 12 o'tdi** |
| TypeScript | `npm run typecheck` | xatosiz |
| Build | `npm run build` | muvaffaqiyatli |
| Brauzer tutun testi (Edge, headless) | — | sahifa chiziladi, uz/ru/ky almashadi, JS xatosi yo'q |

## Talab qilingan holatlar

| # | Holat | Test (fayl › blok) | Natija |
|---|---|---|---|
| 1 | 100 USD va 6 000 USD chegaralari qabul qilinadi | auction › 1. "aniq 100 USD … va aniq 6000 USD" | ✅ |
| 2 | 100 dan past (99, 99.99) va 6 000 dan yuqori (6000.01, 6001) rad | auction › 1. "99 USD, 99.99 USD …" | ✅ |
| 2b | Boshlang'ich/rezerv narx ham chegarada; admin chegarani kengaytira olmaydi | auction › 1 | ✅ |
| 3 | Eng yuqori stavkadan past / teng / qadamdan kichik taklif rad | auction › 2 | ✅ |
| 4 | Bir vaqtdagi stavkalar: 30 parallel ulanish; ikki xaridor bir xil summani bir vaqtda | auction › 3 | ✅ noto'g'ri g'olib yo'q, tarix qat'iy o'sadi |
| 5 | 72 soat: `ends_at = starts_at + 72h` (UTC), muddat o'tgach stavka rad, server natijani aniqlaydi | auction › 4 | ✅ |
| 6 | Oxirgi daqiqalarda stavka → +2 daqiqa, takrorlanadi; o'chirilsa uzaytirilmaydi | auction › 5 | ✅ |
| 7 | Rezerv bajarilmasa sotilgan deb belgilanmaydi; aynan bajarilsa shartli g'olib | auction › 6 | ✅ |
| 8 | G'olib yakunlamadi: manual / auto_relist / offer_runner_up qoidalari | auction › 7 | ✅ |
| 9 | Ruxsatsiz stavka (anon, soxta uid, to'g'ridan-to'g'ri INSERT, o'z avtomobili, tasdiqlanmagan, bloklangan) | security › 8 | ✅ |
| 9b | Ruxsatsiz admin amallari, jadvallarga to'g'ridan-to'g'ri yozish, rolni o'zgartirish, server funksiyalari | security › "Ruxsatsiz admin amallari" | ✅ |

## Qo'shimcha tekshirilganlar
- Valyuta: 1234 USD × 1387.25 = 1 711 867 KRW (0 kasr), 100 USD × 87.4512 = 8 745.12 KGS; kurs snapshot saqlanadi; kurs yo'q/eskirgan bo'lsa stavka **rad** (taxmin qilinmaydi).
- Stavkani hatto superuser ham o'chira/miqdorini o'zgartira olmaydi; admin faqat sababi bilan *bekor qiladi*, tarixda qoladi, jurnalga yoziladi.
- Audit jurnali o'zgarmaydi (UPDATE/DELETE/TRUNCATE taqiqlangan); auksionni to'g'ridan-to'g'ri SQL bilan o'zgartirish ham jurnalga tushadi.
- Pauza: stavka yo'q, davom ettirilganda qolgan vaqt saqlanadi.
- Depozit: so'rov `pending`; mijoz `paid` qila olmaydi; summa mos kelmagan webhook rad; faqat service_role tasdig'idan keyin stavka; avtomatik ushlab qolish/qaytarishni yoqib bo'lmaydi.
- Webhook imzosi: sirsiz, noto'g'ri imzo, o'zgartirilgan tana, eski vaqt tamg'asi — rad.
- Sotuv va auksion: bitta avtomobil ikkalasida bir vaqtda bo'lolmaydi (ikki parallel so'rovda ham).
- Taymer: qurilma soati (`Date.now`) o'zgartirilsa ham qolgan vaqt o'zgarmaydi (monoton soat + server).

## TAYYOR EMAS / hali ulanmagan (tayyor deb e'lon qilinmaydi)
1. **Real to'lov provayderi yo'q.** `payment-webhook` sir sozlanmaguncha 503 qaytaradi — hech bir depozit "to'langan" bo'lmaydi. Provayder (masalan, mahalliy bank/PayBox/Stripe) tanlangach imzo formati moslanadi.
2. **Bildirishnomalar** `notifications` jadvaliga yoziladi, lekin Telegram/SMS/email'ga **yuboruvchi servis yozilmagan**.
3. **Supabase loyihasi yaratilmagan** — interfeys real backend bilan sinalmagan (faqat soxta manzil bilan chizilishi tekshirildi). Real loyihada: migratsiyalarni qo'llash, `pg_cron` yoqish (aks holda `finalize_due_auctions()` ni tashqi cron chaqirishi kerak), Realtime, Auth (email), `kyc` bucket.
4. **Interfeysning end-to-end testi** (brauzer + real backend) yo'q.
5. **Depozitni ushlab qolish/qaytarish siyosati** — huquqiy tekshiruvgacha faqat qo'lda (admin, sababi bilan).
6. Rasm yuklash — hozircha rasm **havolasi** kiritiladi (Storage'ga avtomobil rasmini yuklash UI'si yo'q).
