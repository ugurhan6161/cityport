const firebaseConfig = {
  apiKey: "AIzaSyAVSkmo77MV4nQWsvXUHJ2gNqU5IsgmL4w",
  authDomain: "hotelss-5d21e.firebaseapp.com",
  projectId: "hotelss-5d21e",
  storageBucket: "hotelss-5d21e.firebasestorage.app",
  messagingSenderId: "690208902258",
  appId: "1:690208902258:web:e340e732a111fa6df306eb"
};

let firebaseAuth = null;
let firebaseReady = false;

try {
  if (window.firebase) {
    firebase.initializeApp(firebaseConfig);
    firebaseAuth = firebase.auth();
    firebaseReady = true;
  }
} catch (error) {
  console.warn('Firebase yapılandırması tamamlanamadı; housekeeping verileri için Supabase kullanılacak.', error);
}