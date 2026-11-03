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


// 3 Nov (CEO): a daily tip to overcome burnout and find meaning at work – shown under the tazkirah.
const TIPS = [
  { title: "Rehat sejenak", text: "Ambil 2–3 minit antara pelanggan untuk tarik nafas dalam-dalam: tarik 4 saat, tahan 4 saat, hembus 6 saat. Badan yang tenang membantu fikiran fokus semula." },
  { title: "Ingat 'kenapa' anda", text: "Ingat seorang pelanggan yang pernah anda bantu sehingga dia rasa lega. Itulah makna kerja kita – bukan sekadar jual ubat, tetapi bantu orang sihat." },
  { title: "Satu perkara pada satu masa", text: "Bila kerja bertimbun, tulis 3 perkara paling penting hari ini. Siapkan satu, tanda, kemudian yang seterusnya." },
  { title: "Minum air", text: "Penat dan sakit kepala selalunya tanda kurang air. Letak botol air di tempat yang nampak dan minum setiap kali selesai melayan pelanggan." },
  { title: "Rehat yang betul", text: "Waktu rehat, jauhkan diri dari kaunter dan telefon kerja walaupun 10 minit. Otak perlukan jeda untuk pulih." },
  { title: "Tidur yang cukup", text: "Tidur 7–8 jam adalah 'ubat' paling murah untuk mengelak burnout. Cuba letak telefon jauh dari katil 30 minit sebelum tidur." },
  { title: "Raikan kemenangan kecil", text: "Hari ini, tulis satu perkara yang berjaya – walaupun kecil. Kemajuan kecil setiap hari membina semangat." },
  { title: "Minta bantuan", text: "Tidak perlu tanggung semuanya seorang diri. Bila rasa terbeban, beritahu rakan sekerja atau pengurus – kita satu pasukan." },
  { title: "Senyum dan bertegur sapa", text: "Satu ucapan terima kasih kepada rakan sekerja hari ini boleh menceriakan hari mereka – dan hari anda juga." },
  { title: "Gerakkan badan", text: "Berdiri lama? Regangkan bahu, leher dan betis setiap 1–2 jam. Badan yang bergerak membantu tenaga kekal stabil." },
  { title: "Hadkan berita negatif", text: "Kurangkan menatal media sosial semasa rehat. Isi masa itu dengan sesuatu yang menenangkan – zikir, berbual, atau berjalan sebentar." },
  { title: "Kenal tanda awal burnout", text: "Mudah marah, susah tidur, rasa kosong atau hilang minat? Itu isyarat untuk berehat dan bercakap dengan seseorang, bukan tanda anda lemah." },
  { title: "Tetapkan had", text: "Bila waktu kerja tamat, beri diri anda izin untuk berhenti. Mesej kerja yang tidak segera boleh dijawab esok." },
  { title: "Belajar satu perkara baru", text: "Pelajari satu fakta tentang ubat atau produk hari ini. Rasa berkembang dalam kerja menambah makna dan keyakinan." },
  { title: "Fokus pada apa yang boleh dikawal", text: "Jualan, cuaca, pelanggan yang sukar – tidak semua dalam kawalan kita. Fokus pada layanan dan usaha kita sendiri." },
  { title: "Makan dengan baik", text: "Jangan langkau makan tengah hari. Makanan yang seimbang memberi tenaga yang lebih stabil berbanding kopi dan manisan." },
  { title: "Solat sebagai rehat jiwa", text: "Gunakan waktu solat sebagai masa berhenti sejenak daripada kesibukan – tenangkan hati sebelum menyambung kerja." },
  { title: "Bersyukur", text: "Sebelum pulang, fikirkan 3 perkara yang anda syukuri hari ini. Amalan kecil ini terbukti membantu emosi lebih positif." },
  { title: "Pelanggan yang sukar", text: "Bila berdepan pelanggan marah, ingat – selalunya mereka sedang sakit atau risau. Tarik nafas, dengar dahulu, kemudian bantu." },
  { title: "Kemas ruang kerja", text: "Kaunter yang tersusun membantu fikiran lebih tenang dan kerja lebih cepat. Luangkan 5 minit setiap pagi." },
  { title: "Sasaran sebagai panduan", text: "Sasaran 4DX bukan untuk menekan, tetapi untuk menunjukkan arah. Fokus pada satu langkah lead hari ini – keputusan akan menyusul." },
  { title: "Bercakap tentang perasaan", text: "Kongsi dengan orang yang dipercayai bila rasa tertekan. Meluahkan perasaan meringankan beban di hati." },
  { title: "Masa untuk keluarga", text: "Luangkan masa berkualiti dengan keluarga atau kawan di luar waktu kerja. Hubungan yang baik mengisi semula tenaga emosi." },
  { title: "Jangan bandingkan diri", text: "Setiap orang ada kekuatan berbeza. Bandingkan diri anda hari ini dengan diri anda semalam, bukan dengan orang lain." },
  { title: "Kerja dengan niat", text: "Mulakan syif dengan niat untuk membantu orang. Kerja yang diniatkan kerana Allah menjadi ibadah dan lebih bermakna." },
  { title: "Rehat mata", text: "Kerap melihat skrin? Ikut peraturan 20-20-20: setiap 20 minit, lihat sesuatu sejauh 20 kaki selama 20 saat." },
  { title: "Hargai rakan sepasukan", text: "Beri shout-out kepada seorang rakan di sesi WIG hari Selasa. Pengiktirafan membina semangat pasukan." },
  { title: "Ambil cuti bila perlu", text: "Cuti tahunan ada untuk digunakan. Rancang cuti lebih awal supaya anda kembali dengan tenaga baru." },
  { title: "Kurangkan multitasking", text: "Melayan pelanggan sambil membalas mesej menambah tekanan. Siapkan satu tugas dengan baik sebelum beralih." },
  { title: "Cari makna dalam rutin", text: "Menyusun stok, merekod nombor – semuanya memastikan pelanggan dapat ubat yang mereka perlukan tepat pada masanya." },
  { title: "Beri diri ruang untuk silap", text: "Semua orang buat silap. Belajar, betulkan, dan teruskan – jangan menghukum diri terlalu lama." },
];

// 3 Nov (CEO): alternate day by day – one day a burnout / meaning tip, the next a tip on working
// effectively, so the team runs smooth and efficient.
const EFFECTIVE = [
  { title: "Mula hari dengan 3 keutamaan", text: "Sebelum kedai buka, tulis 3 perkara yang mesti siap hari ini. Yang lain menyusul selepas tiga ini selesai." },
  { title: "Buat terus jika kurang 2 minit", text: "Balas mesej ringkas, susun satu rak, isi satu nombor – kalau boleh siap dalam 2 minit, buat sekarang. Jangan biar ia bertimbun." },
  { title: "Isi nombor hari ini, hari ini", text: "Rekod daily check-in sebelum balik. Nombor yang diisi esok selalunya tersilap dan memakan masa dua kali ganda." },
  { title: "Kumpulkan kerja yang serupa", text: "Semak stok, buat pesanan dan susun barang dalam satu masa yang sama. Bertukar-tukar tugas setiap 5 minit membazir tenaga." },
  { title: "Letak barang di tempat yang sama", text: "Setiap barang ada 'rumah'nya. Bila semua orang simpan di tempat yang sama, tiada masa terbuang mencari." },
  { title: "Tanya awal, bukan lewat", text: "Kalau tidak pasti, tanya sekarang. Satu soalan awal lebih cepat daripada membetulkan kesilapan kemudian." },
  { title: "Laporkan stok habis segera", text: "Nampak barang habis atau hampir habis? Laporkan dalam app hari ini juga – Inventory boleh pindah atau pesan lebih awal." },
  { title: "Selesai sampai habis", text: "Kerja yang 90% siap belum siap. Tutup satu tugas sepenuhnya sebelum mula yang baharu." },
  { title: "Komitmen kecil, ditepati", text: "Dalam sesi WIG, pilih satu komitmen yang benar-benar boleh siap minggu ini. Kecil tetapi ditepati lebih baik daripada besar tetapi tertangguh." },
  { title: "Lihat scoreboard setiap hari", text: "Satu minit melihat scoreboard memberitahu sama ada kita menang atau ketinggalan – dan apa yang perlu dibuat hari ini." },
  { title: "Serah tugas dengan jelas", text: "Bila bertukar syif, tinggalkan nota ringkas: apa yang siap, apa yang belum, siapa pelanggan yang perlu dihubungi semula." },
  { title: "Satu mesej, lengkap", text: "Hantar mesej yang lengkap sekali gus: siapa, apa, berapa, bila. Ini mengelak berbalas-balas mesej yang memakan masa." },
  { title: "Gunakan senarai semak", text: "Untuk kerja berulang – buka kedai, tutup kedai, terima stok – ikut senarai semak. Kurang lupa, kurang stres." },
  { title: "Kenal produk laris", text: "Hafal 20 produk paling laris dan lokasinya. Pelanggan dilayan lebih cepat dan jualan tidak terlepas." },
  { title: "Fokus pada lead measure", text: "Kita tidak boleh kawal jualan secara terus, tetapi boleh kawal tindakan harian – sapa pelanggan, cadang produk, ikut susulan." },
  { title: "Kosongkan meja kaunter", text: "Kaunter yang kemas mempercepat urusan dan nampak profesional. Simpan apa yang tidak perlu sebelum pelanggan seterusnya." },
  { title: "Rancang esok sebelum balik", text: "Lima minit sebelum balik, tulis apa yang perlu dibuat esok. Pagi esok terus mula tanpa berfikir panjang." },
  { title: "Belajar satu perkara baharu", text: "Pilih satu produk atau satu SOP setiap minggu dan fahami betul-betul. Sedikit demi sedikit, kerja jadi lebih lancar." },
  { title: "Kurangkan gangguan", text: "Senyapkan notifikasi yang tidak penting semasa membuat kerja yang perlukan fokus seperti kiraan stok." },
  { title: "Tetapkan masa tamat", text: "Beri setiap tugas had masa – contohnya 20 minit untuk susun rak. Kerja jadi lebih fokus dan tidak meleret." },
  { title: "Betulkan punca, bukan simptom", text: "Masalah yang sama berulang? Tanya 'kenapa' sehingga jumpa puncanya, kemudian cadangkan perubahan melalui 'Request a change'." },
  { title: "Bantu rakan yang sibuk", text: "Kalau anda lapang, tanya rakan: 'Ada apa yang saya boleh bantu?' Pasukan yang saling membantu bergerak lebih pantas." },
  { title: "Mesyuarat yang ringkas", text: "Datang ke mesyuarat dengan nombor dan cadangan yang sudah siap. Mesyuarat jadi pendek dan keputusan lebih cepat." },
  { title: "Susulan dengan pelanggan", text: "Catat nombor pelanggan yang meminta barang habis stok dan hubungi bila barang sampai. Satu panggilan, satu jualan." },
  { title: "Kira stok dengan teliti sekali", text: "Kiraan yang tepat hari ini mengelak kiraan semula, stok negatif dan pesanan yang salah minggu depan." },
  { title: "Jadikan yang betul paling mudah", text: "Susun kedai supaya cara yang betul ialah cara yang paling senang – barang laris dekat kaunter, borang di tempat yang mudah dicapai." },
  { title: "Raikan kemenangan kecil", text: "Capai sasaran harian? Beritahu pasukan. Momentum kecil setiap hari membawa kepada kemenangan bulanan." },
  { title: "Satu sumber maklumat", text: "Rujuk app 4DX untuk sasaran dan nombor, bukan mesej lama di WhatsApp. Semua orang melihat nombor yang sama." },
  { title: "Utamakan yang penting, bukan yang bising", text: "Tidak semua yang mendesak itu penting. Tanya: adakah ini membantu kita capai WIG? Jika tidak, ia boleh tunggu." },
  { title: "Mula awal 10 minit", text: "Sampai 10 minit lebih awal untuk bersedia. Hari yang bermula tenang biasanya berjalan lebih lancar." },
  { title: "Perbaiki 1% setiap hari", text: "Cari satu perkara kecil yang boleh dibuat lebih baik hari ini. 1% setiap hari menjadi perubahan besar dalam sebulan." },
];

function tipFor(date) {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  const list = day % 2 === 0 ? TIPS : EFFECTIVE;
  const i = Math.floor(day / 2);
  const t = list[((i % list.length) + list.length) % list.length];
  return { ...t, kind: list === TIPS ? 'care' : 'effective' };
}

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

module.exports = { LIST, TIPS, EFFECTIVE, forDate, tipFor, today };
