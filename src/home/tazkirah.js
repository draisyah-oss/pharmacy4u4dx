// 3 Nov 2026 (CEO): one tazkirah a day at the top of the News – a Quran verse, a hadith or a short
// reminder about helping people and health. 3 Nov (CEO): all in English – the meanings are our own
// wording of the well-known English translations, with the source. Rotates by date (same one for
// everyone that day). To turn it off: app_settings tazkirah_off = "1". To add one: append (keep the source).

const LIST = [
  { kind: 'Al-Quran', text: 'Help one another in goodness and righteousness, and do not help one another in sin and aggression.', src: 'Surah Al-Ma’idah, 5:2' },
  { kind: 'Hadith', text: 'The best of people are those most beneficial to others.', src: 'Narrated by At-Tabarani and Ad-Daraqutni' },
  { kind: 'Hadith', text: 'Allah has not sent down any disease without also sending down its cure.', src: 'Narrated by Al-Bukhari' },
  { kind: 'Al-Quran', text: 'And when I am ill, it is He who cures me.', src: 'Surah Ash-Shu’ara’, 26:80' },
  { kind: 'Hadith', text: 'Allah helps His servant as long as the servant helps his brother.', src: 'Narrated by Muslim' },
  { kind: 'Al-Quran', text: 'Whoever saves one life, it is as if he has saved the whole of mankind.', src: 'Surah Al-Ma’idah, 5:32' },
  { kind: 'Hadith', text: 'There are two blessings that many people lose out on: good health and free time.', src: 'Narrated by Al-Bukhari' },
  { kind: 'Reminder', text: 'Every customer who comes to our counter brings a hope of getting well. A smile, clear advice and the right medicine – all of it is part of that effort.', src: 'Pharmacy4U' },
  { kind: 'Hadith', text: 'For every disease there is a cure. When the cure matches the disease, it is healed by the permission of Allah.', src: 'Narrated by Muslim' },
  { kind: 'Al-Quran', text: 'And do good; indeed, Allah loves those who do good.', src: 'Surah Al-Baqarah, 2:195' },
  { kind: 'Hadith', text: 'Your smile to your brother is charity.', src: 'Narrated by At-Tirmidhi' },
  { kind: 'Hadith', text: 'Whoever relieves a believer of a hardship of this world, Allah will relieve him of a hardship on the Day of Judgement.', src: 'Narrated by Muslim' },
  { kind: 'Al-Quran', text: 'Eat and drink, but do not be excessive. Indeed, He does not like those who are excessive.', src: 'Surah Al-A’raf, 7:31' },
  { kind: 'Hadith', text: 'The strong believer is better and more beloved to Allah than the weak believer, and in both there is good.', src: 'Narrated by Muslim' },
  { kind: 'Reminder', text: 'Looking after your own health is a trust too. Rest enough, drink enough water and take time to pray calmly – we can help others better when we are well ourselves.', src: 'Pharmacy4U' },
  { kind: 'Al-Quran', text: 'For indeed, with hardship comes ease. Indeed, with hardship comes ease.', src: 'Surah Ash-Sharh, 94:5–6' },
  { kind: 'Hadith', text: 'None of you truly believes until he loves for his brother what he loves for himself.', src: 'Narrated by Al-Bukhari and Muslim' },
  { kind: 'Hadith', text: 'Visit the sick, feed the hungry and free the captive.', src: 'Narrated by Al-Bukhari' },
  { kind: 'Al-Quran', text: 'And say: Do your work, for Allah will see your work, and so will His Messenger and the believers.', src: 'Surah At-Tawbah, 9:105' },
  { kind: 'Hadith', text: 'Take advantage of five before five: your youth before old age, your health before sickness, your wealth before poverty, your free time before you are busy, and your life before death.', src: 'Narrated by Al-Hakim' },
  { kind: 'Hadith', text: 'The believers in their love and mercy for one another are like one body: when one part hurts, the whole body feels it.', src: 'Narrated by Al-Bukhari and Muslim' },
  { kind: 'Reminder', text: 'Elderly or unwell customers may need more time. Be patient, explain the dose slowly, and make sure they understand before they leave.', src: 'Pharmacy4U' },
  { kind: 'Al-Quran', text: 'O you who believe, seek help through patience and prayer. Indeed, Allah is with the patient.', src: 'Surah Al-Baqarah, 2:153' },
  { kind: 'Hadith', text: 'Make things easy and do not make them hard; give good news and do not drive people away.', src: 'Narrated by Al-Bukhari and Muslim' },
  { kind: 'Hadith', text: 'Cleanliness is half of faith.', src: 'Narrated by Muslim' },
  { kind: 'Al-Quran', text: 'Allah does not burden a soul beyond what it can bear.', src: 'Surah Al-Baqarah, 2:286' },
  { kind: 'Hadith', text: 'A good word is charity.', src: 'Narrated by Al-Bukhari and Muslim' },
  { kind: 'Hadith', text: 'The deeds most loved by Allah are those done consistently, even if they are small.', src: 'Narrated by Al-Bukhari and Muslim' },
  { kind: 'Al-Quran', text: 'Those who spend in ease and in hardship, who hold back their anger and forgive people – Allah loves those who do good.', src: 'Surah Aal ‘Imran, 3:134' },
  { kind: 'Hadith', text: 'Allah loves that when one of you does a job, he does it well.', src: 'Narrated by Al-Bayhaqi' },
  { kind: 'Reminder', text: 'One follow-up message to a customer – “Feeling better?” – may be small for us, but it means a lot to someone who is unwell.', src: 'Pharmacy4U' },
  { kind: 'Al-Quran', text: 'Indeed, Allah will not change the condition of a people until they change what is in themselves.', src: 'Surah Ar-Ra’d, 13:11' },
];

// 3 Nov (CEO): a daily tip to overcome burnout and find meaning at work – shown under the tazkirah.
const TIPS = [
  { title: "Pause for a moment", text: "Take 2–3 minutes between customers for a deep breath: in for 4 seconds, hold for 4, out for 6. A calm body helps the mind refocus." },
  { title: "Remember your 'why'", text: "Think of one customer you helped until they felt relieved. That is the meaning of our work – not just selling medicine, but helping people get well." },
  { title: "One thing at a time", text: "When work piles up, write down the 3 most important things for today. Finish one, tick it, then the next." },
  { title: "Drink water", text: "Tiredness and headaches are often a sign of too little water. Keep a bottle where you can see it and drink after every customer." },
  { title: "Take a proper break", text: "On your break, step away from the counter and the work phone, even for 10 minutes. The brain needs a pause to recover." },
  { title: "Get enough sleep", text: "7–8 hours of sleep is the cheapest 'medicine' against burnout. Try putting your phone away from the bed 30 minutes before sleeping." },
  { title: "Celebrate small wins", text: "Today, write down one thing that went well – however small. Small progress every day builds spirit." },
  { title: "Ask for help", text: "You don't have to carry everything alone. When you feel overloaded, tell a colleague or your manager – we are one team." },
  { title: "Smile and say thank you", text: "One thank-you to a colleague today can brighten their day – and yours too." },
  { title: "Move your body", text: "Standing for long? Stretch your shoulders, neck and calves every 1–2 hours. Moving keeps your energy steady." },
  { title: "Limit negative news", text: "Scroll less on social media during breaks. Fill the time with something calming – dhikr, a chat, or a short walk." },
  { title: "Know the early signs of burnout", text: "Easily irritated, sleeping badly, feeling empty or losing interest? That is a signal to rest and talk to someone, not a sign of weakness." },
  { title: "Set limits", text: "When your working hours end, give yourself permission to stop. Work messages that aren't urgent can be answered tomorrow." },
  { title: "Learn one new thing", text: "Learn one fact about a medicine or product today. Growing at work adds meaning and confidence." },
  { title: "Focus on what you can control", text: "Sales, the weather, difficult customers – not everything is in our control. Focus on your own service and effort." },
  { title: "Eat well", text: "Don't skip lunch. A balanced meal gives steadier energy than coffee and sweets." },
  { title: "Prayer as a rest for the soul", text: "Use prayer time as a pause from the rush – calm your heart before going back to work." },
  { title: "Be grateful", text: "Before going home, think of 3 things you are grateful for today. This small habit is proven to lift your mood." },
  { title: "Difficult customers", text: "When facing an angry customer, remember – they are often unwell or worried. Breathe, listen first, then help." },
  { title: "Tidy your workspace", text: "An organised counter keeps the mind calmer and the work faster. Spend 5 minutes on it every morning." },
  { title: "Targets as a guide", text: "4DX targets are not there to pressure you but to show the direction. Focus on one lead measure today – the results will follow." },
  { title: "Talk about how you feel", text: "Share with someone you trust when you feel stressed. Talking it out lightens the load." },
  { title: "Time for family", text: "Spend quality time with family or friends outside work. Good relationships recharge your emotional energy." },
  { title: "Don't compare yourself", text: "Everyone has different strengths. Compare yourself today with yourself yesterday, not with others." },
  { title: "Work with intention", text: "Start your shift with the intention of helping people. Work done for the sake of Allah becomes worship and more meaningful." },
  { title: "Rest your eyes", text: "Looking at screens a lot? Follow the 20-20-20 rule: every 20 minutes, look at something 20 feet away for 20 seconds." },
  { title: "Appreciate your teammates", text: "Give a colleague a shout-out at Tuesday's WIG session. Recognition builds team spirit." },
  { title: "Take leave when you need it", text: "Annual leave is there to be used. Plan your leave early so you come back with fresh energy." },
  { title: "Multitask less", text: "Serving a customer while replying to messages adds stress. Finish one task well before moving on." },
  { title: "Find meaning in routine", text: "Arranging stock, recording numbers – all of it makes sure customers get the medicine they need on time." },
  { title: "Give yourself room to make mistakes", text: "Everyone makes mistakes. Learn, fix it and move on – don't punish yourself for too long." },
];

// 3 Nov (CEO): alternate day by day – one day a burnout / meaning tip, the next a tip on working
// effectively, so the team runs smooth and efficient.
const EFFECTIVE = [
  { title: "Start the day with 3 priorities", text: "Before the shop opens, write the 3 things that must be done today. Everything else comes after these three." },
  { title: "Do it now if it takes under 2 minutes", text: "Reply to a short message, tidy one shelf, fill in one number – if it takes 2 minutes, do it now. Don't let it pile up." },
  { title: "Today's numbers, today", text: "Do your daily check-in before going home. Numbers filled in tomorrow are often wrong and take twice as long." },
  { title: "Batch similar work", text: "Check stock, place orders and arrange items in one go. Switching tasks every 5 minutes wastes energy." },
  { title: "Everything in its place", text: "Every item has a 'home'. When everyone puts things back in the same place, no time is lost searching." },
  { title: "Ask early, not late", text: "If you're not sure, ask now. One early question is faster than fixing a mistake later." },
  { title: "Report out-of-stock right away", text: "See an item out or running low? Report it in the app today – Inventory can transfer or order earlier." },
  { title: "Finish what you start", text: "Work that is 90% done is not done. Close one task completely before starting a new one." },
  { title: "Small commitments, kept", text: "In the WIG session, pick one commitment you can really finish this week. Small and kept beats big and delayed." },
  { title: "Look at the scoreboard daily", text: "One minute on the scoreboard tells you whether we are winning or behind – and what to do today." },
  { title: "Hand over clearly", text: "At shift change, leave a short note: what's done, what's not, which customers need a call back." },
  { title: "One complete message", text: "Send a complete message in one go: who, what, how many, when. It saves a long back-and-forth." },
  { title: "Use checklists", text: "For repeat work – opening, closing, receiving stock – follow a checklist. Fewer things forgotten, less stress." },
  { title: "Know the best sellers", text: "Know the top 20 best-selling products and where they are. Customers are served faster and no sale is missed." },
  { title: "Focus on the lead measures", text: "We can't control sales directly, but we can control daily actions – greet customers, suggest products, follow up." },
  { title: "Clear the counter", text: "A tidy counter speeds things up and looks professional. Put away what isn't needed before the next customer." },
  { title: "Plan tomorrow before you leave", text: "Five minutes before going home, write what needs doing tomorrow. Start straight away the next morning." },
  { title: "Learn one thing a week", text: "Pick one product or one SOP each week and understand it well. Little by little, the work gets smoother." },
  { title: "Cut the distractions", text: "Silence non-urgent notifications when doing focused work like stock counts." },
  { title: "Set an end time", text: "Give each task a time limit – say 20 minutes to arrange a shelf. Work stays focused instead of dragging on." },
  { title: "Fix the cause, not the symptom", text: "Same problem keeps coming back? Ask 'why' until you find the cause, then suggest a change through 'Request a change'." },
  { title: "Help a busy teammate", text: "If you're free, ask a colleague: 'Anything I can help with?' Teams that help each other move faster." },
  { title: "Short meetings", text: "Come to meetings with your numbers and suggestions ready. Meetings get shorter and decisions faster." },
  { title: "Follow up with customers", text: "Note the number of customers asking for out-of-stock items and call them when it arrives. One call, one sale." },
  { title: "Count stock carefully, once", text: "An accurate count today avoids recounts, negative stock and wrong orders next week." },
  { title: "Make the right way the easy way", text: "Arrange the shop so the right way is the easiest – best sellers near the counter, forms within easy reach." },
  { title: "Share the small wins", text: "Hit the daily target? Tell the team. Small momentum every day leads to a winning month." },
  { title: "One source of truth", text: "Use the 4DX app for targets and numbers, not old WhatsApp messages. Everyone sees the same numbers." },
  { title: "Important over noisy", text: "Not everything urgent is important. Ask: does this help us hit the WIG? If not, it can wait." },
  { title: "Start 10 minutes early", text: "Arrive 10 minutes early to get ready. A day that starts calm usually runs smoother." },
  { title: "Improve 1% every day", text: "Find one small thing you can do better today. 1% a day becomes a big change in a month." },
];

function tipFor(date) {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  const list = day % 2 === 0 ? TIPS : EFFECTIVE;
  const i = Math.floor(day / 2);
  const t = list[((i % list.length) + list.length) % list.length];
  return { ...t, kind: list === TIPS ? 'care' : 'effective' };
}

const KIND_EMOJI = { 'Al-Quran': '📖', Hadith: '🌙', Reminder: '🤲' };

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
