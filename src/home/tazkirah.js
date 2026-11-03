// 3 Nov 2026 (CEO): one tazkirah a day at the top of the News – a Quran verse, a hadith or a short
// reminder about helping people and health. The meanings are given in Malay, in our own wording of
// the well-known translations, with the source. Rotates by date (same one for everyone that day).
// To turn it off: app_settings tazkirah_off = "1". To add one: append to the list (keep the source).

const LIST = [
  { kind: 'Al-Quran', text: 'Dan tolong-menolonglah kamu dalam mengerjakan kebaikan dan takwa, dan jangan tolong-menolong dalam dosa dan permusuhan.', src: 'Surah Al-Ma’idah, 5:2' },
  { kind: 'Hadis', text: 'Sebaik-baik manusia ialah yang paling bermanfaat kepada manusia lain.', src: 'Riwayat At-Tabarani dan Ad-Daruqutni' },
  { kind: 'Hadis', text: 'Allah tidak menurunkan sesuatu penyakit melainkan Dia turunkan juga penawarnya.', src: 'Riwayat Al-Bukhari' },
  { kind: 'Al-Quran', text: 'Dan apabila aku sakit, Dialah yang menyembuhkan aku.', src: 'Surah Asy-Syu’ara’, 26:80' },
  { kind: 'Hadis', text: 'Allah sentiasa menolong seorang hamba selagi hamba itu menolong saudaranya.', src: 'Riwayat Muslim' },
  { kind: 'Al-Quran', text: 'Dan sesiapa yang memelihara kehidupan seorang manusia, maka seolah-olah dia telah memelihara kehidupan manusia semuanya.', src: 'Surah Al-Ma’idah, 5:32' },
  { kind: 'Hadis', text: 'Dua nikmat yang ramai manusia terleka padanya: kesihatan dan masa lapang.', src: 'Riwayat Al-Bukhari' },
  { kind: 'Tazkirah', text: 'Setiap pelanggan yang datang ke kaunter kita membawa harapan untuk sembuh. Senyuman, nasihat yang jelas dan ubat yang tepat – semuanya sebahagian daripada ikhtiar itu.', src: 'Pharmacy4U' },
  { kind: 'Hadis', text: 'Setiap penyakit ada ubatnya. Apabila ubat itu tepat dengan penyakitnya, ia sembuh dengan izin Allah.', src: 'Riwayat Muslim' },
  { kind: 'Al-Quran', text: 'Dan berbuat baiklah, sesungguhnya Allah menyukai orang-orang yang berbuat baik.', src: 'Surah Al-Baqarah, 2:195' },
  { kind: 'Hadis', text: 'Senyumanmu kepada saudaramu adalah sedekah.', src: 'Riwayat At-Tirmizi' },
  { kind: 'Hadis', text: 'Sesiapa yang melepaskan seorang mukmin daripada satu kesusahan dunia, Allah akan melepaskannya daripada satu kesusahan pada hari kiamat.', src: 'Riwayat Muslim' },
  { kind: 'Al-Quran', text: 'Makan dan minumlah, dan janganlah berlebih-lebihan. Sesungguhnya Allah tidak menyukai orang yang berlebih-lebihan.', src: 'Surah Al-A’raf, 7:31' },
  { kind: 'Hadis', text: 'Mukmin yang kuat lebih baik dan lebih dikasihi Allah daripada mukmin yang lemah, dan pada kedua-duanya ada kebaikan.', src: 'Riwayat Muslim' },
  { kind: 'Tazkirah', text: 'Menjaga kesihatan diri juga amanah. Cukupkan rehat, minum air secukupnya dan ambil masa untuk solat dengan tenang – kita lebih mampu membantu orang lain bila kita sendiri sihat.', src: 'Pharmacy4U' },
  { kind: 'Al-Quran', text: 'Maka sesungguhnya bersama kesulitan ada kemudahan. Sesungguhnya bersama kesulitan ada kemudahan.', src: 'Surah Al-Insyirah, 94:5–6' },
  { kind: 'Hadis', text: 'Tidak sempurna iman seseorang daripada kamu sehingga dia mengasihi saudaranya sebagaimana dia mengasihi dirinya sendiri.', src: 'Riwayat Al-Bukhari dan Muslim' },
  { kind: 'Hadis', text: 'Ziarahilah orang yang sakit, berilah makan orang yang lapar, dan bebaskanlah tawanan.', src: 'Riwayat Al-Bukhari' },
  { kind: 'Al-Quran', text: 'Dan katakanlah: Bekerjalah kamu, maka Allah, Rasul-Nya dan orang-orang yang beriman akan melihat pekerjaan kamu.', src: 'Surah At-Taubah, 9:105' },
  { kind: 'Hadis', text: 'Rebutlah lima perkara sebelum lima perkara: mudamu sebelum tua, sihatmu sebelum sakit, kayamu sebelum miskin, lapangmu sebelum sempit, dan hidupmu sebelum mati.', src: 'Riwayat Al-Hakim' },
  { kind: 'Hadis', text: 'Perumpamaan orang-orang beriman dalam kasih sayang dan belas kasihan sesama mereka seperti satu tubuh: apabila satu anggota sakit, seluruh tubuh turut merasainya.', src: 'Riwayat Al-Bukhari dan Muslim' },
  { kind: 'Tazkirah', text: 'Pelanggan warga emas atau yang kurang sihat mungkin perlukan lebih masa. Bersabar, terangkan dos dengan perlahan, dan pastikan mereka faham sebelum pulang.', src: 'Pharmacy4U' },
  { kind: 'Al-Quran', text: 'Wahai orang-orang yang beriman, mohonlah pertolongan dengan sabar dan solat. Sesungguhnya Allah bersama orang-orang yang sabar.', src: 'Surah Al-Baqarah, 2:153' },
  { kind: 'Hadis', text: 'Permudahkanlah dan jangan menyusahkan, gembirakanlah dan jangan menjauhkan.', src: 'Riwayat Al-Bukhari dan Muslim' },
  { kind: 'Hadis', text: 'Bersuci itu sebahagian daripada iman.', src: 'Riwayat Muslim' },
  { kind: 'Al-Quran', text: 'Allah tidak membebani seseorang melainkan sesuai dengan kesanggupannya.', src: 'Surah Al-Baqarah, 2:286' },
  { kind: 'Hadis', text: 'Kalimah yang baik itu sedekah.', src: 'Riwayat Al-Bukhari dan Muslim' },
  { kind: 'Hadis', text: 'Amalan yang paling disukai Allah ialah yang berterusan walaupun sedikit.', src: 'Riwayat Al-Bukhari dan Muslim' },
  { kind: 'Al-Quran', text: 'Orang-orang yang menafkahkan hartanya pada waktu senang dan susah, menahan marah dan memaafkan manusia – Allah menyukai orang-orang yang berbuat kebaikan.', src: 'Surah Ali ‘Imran, 3:134' },
  { kind: 'Hadis', text: 'Sesungguhnya Allah suka apabila seseorang daripada kamu melakukan sesuatu pekerjaan, dia melakukannya dengan tekun dan sempurna.', src: 'Riwayat Al-Baihaqi' },
  { kind: 'Tazkirah', text: 'Satu pesanan susulan kepada pelanggan – “Dah rasa lebih baik?” – mungkin kecil bagi kita, tetapi besar maknanya bagi orang yang sedang sakit.', src: 'Pharmacy4U' },
  { kind: 'Al-Quran', text: 'Sesungguhnya Allah tidak mengubah keadaan sesuatu kaum sehingga mereka mengubah apa yang ada pada diri mereka sendiri.', src: 'Surah Ar-Ra’d, 13:11' },
];

const KIND_EMOJI = { 'Al-Quran': '📖', Hadis: '🌙', Tazkirah: '🤲' };

// The tazkirah for a date (YYYY-MM-DD, Malaysia time).
function forDate(date) {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  const t = LIST[((day % LIST.length) + LIST.length) % LIST.length];
  return { ...t, emoji: KIND_EMOJI[t.kind] || '🌙' };
}

async function today(db, date) {
  const off = (await db.query("SELECT value FROM app_settings WHERE key = 'tazkirah_off'")).rows[0];
  if (off && off.value && off.value !== '0' && off.value !== 'false') return null;
  return forDate(date);
}

module.exports = { LIST, forDate, today };
