// Minimal NoSleep.js functionality for mobile wake lock
class NoSleep {
  enable() {
    if('wakeLock' in navigator){
      navigator.wakeLock.request('screen').then(lock=>{
        this.lock = lock;
      }).catch(console.error);
    }
  }
  disable() {
    if(this.lock) this.lock.release();
  }
}
window.noSleep = new NoSleep();
