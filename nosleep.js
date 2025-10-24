// nosleep.js - keep screen awake

class NoSleep {
    constructor() {
        this.wakeLock = null;
        this.enabled = false;
    }

    async enable() {
        if (this.enabled) return;

        if ('wakeLock' in navigator) {
            try {
                this.wakeLock = await navigator.wakeLock.request('screen');
                this.enabled = true;
                console.log('WakeLock enabled');
                document.addEventListener('visibilitychange', async () => {
                    if (!document.hidden && !this.wakeLock) {
                        try {
                            this.wakeLock = await navigator.wakeLock.request('screen');
                        } catch(e) { console.warn('WakeLock request failed', e); }
                    }
                });
            } catch(e) {
                console.warn('WakeLock failed:', e);
            }
        } else {
            // Fallback for older browsers: tiny video trick
            this.video = document.createElement('video');
            this.video.src = 'data:video/mp4;base64,AAAAHGZ0eXBtcDQyAAAAAGlzb21tcDQyAAAAAG1wNDEAAA...'; // tiny blank video
            this.video.loop = true;
            this.video.muted = true;
            this.video.play();
            this.enabled = true;
            console.log('NoSleep fallback enabled');
        }
    }

    disable() {
        if (!this.enabled) return;

        if (this.wakeLock) {
            this.wakeLock.release().then(() => {
                this.wakeLock = null;
                console.log('WakeLock released');
            });
        }
        if (this.video) {
            this.video.pause();
            this.video = null;
        }

        this.enabled = false;
    }
}

// Usage
const noSleep = new NoSleep();
document.addEventListener('click', ()=>{ noSleep.enable(); }); // user gesture required on some browsers
