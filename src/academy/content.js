// Trial module content, loaded into academy_modules the first time a module is missing.
// Medical content is a learning aid only; every module page shows the pharmacist line.

const MODULES = [
  {
    code: '1.5', title: 'Itchy eye vs dry eye', track: 'Skin, Eye and Mouth', minutes: 4,
    source: 'Classroom deck 14, Itchy Eye vs Dry Eye', sort_order: 15,
    cards: [
      { front: 'Itchy eyes: what is really going on?', back: 'Itch is a symptom, not a diagnosis. When itch is the main complaint, think allergy first. Dust, pollen, pet dander or haze trigger histamine, which causes itch, swelling and watering.' },
      { front: 'Dry eye in one line?', back: 'The tear film cannot keep the eye surface wet, smooth and protected. Clue: vision blurs, then clears when they blink. Itch is mild or absent.' },
      { front: 'Why can dry eyes be watery?', back: 'The oily layer is poor, so tears evaporate fast and the eye makes extra water to cope.' },
      { front: 'Who is at risk of dry eye?', back: 'Aircond and smoking, age over 50, women and pregnancy, LASIK, autoimmune or thyroid conditions, and some medicines (antihistamines, decongestants, beta blockers, antidepressants).' },
    ],
    questions: [
      { q: 'Encik Hafiz says his eyes are so itchy, especially after sweeping the dusty storeroom. What is the most likely driver?', options: ['Dry eye', 'Allergic reaction', 'Tired eyes', 'Too much screen time'], correct: [1], why: 'Itch is the main complaint and dust is a trigger, so allergy comes first.' },
      { q: 'Puan Mei says her vision goes blurry, then clears when she blinks. It is not really itchy. What does this point to?', options: ['Allergic reaction', 'Dry eye', 'Contact lens solution', 'Nothing to worry about'], correct: [1], why: 'Blur that clears on blinking is a strong clue the tear film is unstable, and itch is mild or absent in dry eye.' },
      { q: 'Why can a dry eye be watery?', options: ['Too much oil on the eye', 'Poor oil makes tears evaporate, so the eye over-produces water', 'It is always an infection', 'It means the eye is healthy'], correct: [1], why: 'Watery does not mean not dry. Explain this to customers simply, because it surprises them.' },
      { q: 'Select all dry-eye risk factors for Mr Lim, 58, who works in an air-conditioned office and takes a beta blocker.', options: ['Air-conditioning', 'Age over 50', 'Beta blocker', 'Drinking kopi'], correct: [0, 1, 2], multi: true, why: 'Three of four apply. Never tell a customer to stop or change a medicine. Mention it to the pharmacist.' },
      { q: 'A customer with a very red, painful eye who is sensitive to light asks for any eye drops. What do you do?', options: ['Sell the most popular drop', 'Bring them to the pharmacist now', 'Tell them to rest and come back', 'Suggest a cold compress'], correct: [1], why: 'Pain, light sensitivity or a sudden change in vision are red flags. Do not guess. Referring earns XP and never loses it.' },
    ],
    roleplay: {
      customer: 'Aunty Rohani, 62, says: Nak beli ubat mata.',
      rounds: [
        { prompt: 'Aunty Rohani, 62, says: Nak beli ubat mata. What do you say?', options: [
          { text: 'This one very popular, aunty.', best: false, feedback: 'You recommended before asking.' },
          { text: 'Boleh saya tanya, mata aunty paling bermasalah macam mana: gatal, kering, atau kabur? Bila jadi?', best: true, feedback: 'It asks what bothers her most and when.' },
          { text: 'Aunty kena jumpa doktor.', best: false, feedback: 'Referral is for red flags, not the first reply.' },
        ] },
        { prompt: 'She answers: Kering, macam berpasir, lepas kerja dalam pejabat aircond. Tak gatal. What next?', options: [
          { text: 'Check red flags first (pain, light sensitivity, vision change, contact lenses), then show the lubricating options from the deck.', best: true, feedback: 'You matched her answer and checked safety first.' },
          { text: 'Offer the biggest pack.', best: false, feedback: 'It does not match her need.' },
          { text: 'Recommend an allergy product because eyes are involved.', best: false, feedback: 'She said no itch.' },
        ] },
      ],
      ending: 'Best ending: explain how to use the product, say when to see the pharmacist or doctor if it does not improve or gets worse, and, with her permission, offer a follow-up message in a week.',
    },
    challenge: {
      intro: 'This week, use these 3 questions with 2 customers who ask about eye products: 1) What bothers you most: itch, dryness or blur? 2) When does it happen: after dust, in the aircond, all day? 3) Any pain, light sensitivity, contact lenses or eye medicines?',
      fields: [
        { key: 'complaint', label: 'Main complaint', type: 'select', options: ['Itchy', 'Dry', 'Blurry'] },
        { key: 'red_flag', label: 'Red flag', type: 'select', options: ['Yes', 'No'] },
        { key: 'referred', label: 'Referred', type: 'select', options: ['Yes', 'No'] },
      ],
      checks: ['Asked what bothers them most', 'Asked when it happens', 'Checked red flags', 'Recommendation matched what the customer said'],
      needed: 3,
    },
  },
  {
    code: '5.1', title: 'Stock Gap Hero', track: 'Stock Heroes and Safe Practice', minutes: 4,
    source: 'New module, no classroom deck yet', sort_order: 51,
    cards: [
      { front: 'What is a stock gap?', back: 'A customer asks for something we do not have, or the shelf is empty. A gap that is not logged is invisible to HQ.' },
      { front: 'Spot. Log. Escalate.', back: 'Spot it. Log it in the same shift with the product, size or strength, how many customers asked, and the date. Tell your manager the same day.' },
      { front: 'Which gap first?', back: 'Medicines customers take every day come first, then fast sellers, then everything else.' },
      { front: 'Close the loop.', back: 'Tell the customer the expected date or a pharmacist-approved alternative, and mark the log when stock arrives.' },
    ],
    questions: [
      { q: 'After serving a customer who asked for a product we do not have, what is next?', options: ['Nothing, they will come back', 'Log it before the shift ends', 'Wait for the Friday huddle', 'Tell the customer to try another shop'], correct: [1], why: 'A gap logged in the same shift is one HQ can act on.' },
      { q: 'Which log entry can HQ act on?', options: ['Out of stock, cough syrup', 'Glucose test strips, 50s, 3 customers asked, Tue 4 Nov', 'Vitamin, finished', 'Stock problem'], correct: [1], why: 'A good entry names the product, size, how many customers asked and the date.' },
      { q: 'Which gap do you escalate first?', options: ['A flavour of vitamin gummy', 'A daily medicine a long-term customer runs out of in 2 days', 'A slow-moving item', 'A display item'], correct: [1], why: 'Daily medicines come first.' },
      { q: 'A customer wants a product that is out. Best reply?', options: ['Habis, sorry.', 'Saya semak bila stok masuk dan boleh WhatsApp bila ada? Kalau perlu, farmasi boleh cadangkan pengganti.', 'Hand over a different brand without telling them', 'Try the next outlet.'], correct: [1], why: 'Ask permission before following up, and let the pharmacist suggest any substitute.' },
    ],
    roleplay: {
      customer: 'Encik Azman, 55, asks: Test strip biasa saya mana? The shelf is empty.',
      rounds: [
        { prompt: 'Encik Azman, 55, asks: Test strip biasa saya mana? The shelf is empty. What do you do?', options: [
          { text: 'Apologise, check the back room and other sizes, then explain what you will do next.', best: true, feedback: '' },
          { text: 'Habis. and walking away.', best: false, feedback: '' },
        ] },
        { prompt: 'He is not in a hurry.', options: [
          { text: 'Ask if you may WhatsApp him when stock arrives, and offer to let the pharmacist advise if he needs an alternative now.', best: true, feedback: '' },
        ] },
        { prompt: 'After he leaves.', options: [
          { text: 'Log the entry straight away with the product, size, number of customers asked and date.', best: true, feedback: '' },
          { text: 'I will remember to tell my manager on Friday.', best: false, feedback: '' },
        ] },
      ],
      ending: '',
    },
    challenge: {
      intro: 'This week, log every stock gap you meet in the same shift, with all four details, and close the loop with at least one customer.',
      fields: [
        { key: 'product', label: 'Product', type: 'text' },
        { key: 'size', label: 'Size or strength', type: 'text' },
        { key: 'asked', label: 'Number of customers who asked', type: 'number' },
        { key: 'date', label: 'Date', type: 'date' },
      ],
      checks: ['Names the product and size', 'Records how many customers asked', 'Records the date'],
      needed: 3,
    },
  },
];

module.exports = { MODULES };
