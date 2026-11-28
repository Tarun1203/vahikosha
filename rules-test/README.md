# Firestore rules tests

Checks `../firestore.rules` in the Firebase emulator, on this computer only. Nothing reaches the real Firebase project.

You need Node 20+ and Java 11+.

```
cd rules-test
npm install
npm test
```

The first run downloads the emulator (about 60 MB).
