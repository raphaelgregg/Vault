/**
 * Fonte única do import map (o app é estático, sem bundler).
 *
 * Script clássico e síncrono: roda antes de qualquer <script type="module">
 * e injeta o <script type="importmap"> no <head>. Para trocar a versão do SDK,
 * altere FIREBASE_VERSION aqui — nenhum HTML precisa ser editado.
 *
 * Se por algum motivo a página já tiver um import map declarado, nada é feito.
 */
(function injectImportMap() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('script[type="importmap"]')) return;

  var FIREBASE_VERSION = '10.12.2';
  var base = 'https://www.gstatic.com/firebasejs/' + FIREBASE_VERSION + '/';

  var map = {
    imports: {
      'firebase/app': base + 'firebase-app.js',
      'firebase/auth': base + 'firebase-auth.js',
      'firebase/firestore': base + 'firebase-firestore.js',
    },
  };

  var script = document.createElement('script');
  script.type = 'importmap';
  script.textContent = JSON.stringify(map);
  document.head.appendChild(script);
})();
