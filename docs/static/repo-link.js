/* Footer link to the GitHub repository, derived from the GitHub Pages address. */
(function () {
  var a = document.querySelectorAll('.tc-repo');
  if (!a.length) return;
  var h = location.hostname, m = h.match(/^([^.]+)\.github\.io$/i), url = 'https://github.com/';
  if (m) {
    var repo = location.pathname.split('/').filter(Boolean)[0];
    url += m[1] + '/' + (repo && !/\.html$/i.test(repo) ? repo : m[1] + '.github.io');
  }
  if (m) a.forEach(function (el) { el.href = url; });
})();
