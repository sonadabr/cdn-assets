(function() {
    try {
        var s = document.createElement('script');
        s.type = 'module';
        // Substitua pela URL real do seu script no Railway
        s.src = 'https://soneda-br.fbitsstatics.net/script/metrics-core.js';
        s.async = true;
        (document.head || document.documentElement).appendChild(s);
    } catch(e) {
        console.error("null");
    }
})();