from django.contrib.auth.mixins import LoginRequiredMixin, UserPassesTestMixin
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.generic import TemplateView

from rea.apps.accounts.permissions import is_teacher


@method_decorator(ensure_csrf_cookie, name="dispatch")
class IndexView(LoginRequiredMixin, TemplateView):
    """
    The practice app shell.

    Sign-in required: practice is only worth recording when it belongs to
    someone, so anonymous visitors are sent to the login page (which offers
    account creation) rather than to a browser-local scratch copy of their
    progress.

    ``ensure_csrf_cookie`` so the page always carries a CSRF token: a signed-in
    user's completed sessions are POSTed to the accounts API from JavaScript,
    and without the cookie that first POST would fail on a cold page load.
    """

    template_name = "rea_frontend/index.html"


class AboutView(LoginRequiredMixin, TemplateView):
    """
    Introduction, the REA method, and theory.

    These three chapters are prose, not exercises: they have no lessons, no
    parts and no ten practice modes, so sitting them in the curriculum meant
    Next walked out of practice and into reading.  They live here instead,
    one page away from the app.
    """

    template_name = "rea_frontend/about.html"


@method_decorator(ensure_csrf_cookie, name="dispatch")
class EditorView(UserPassesTestMixin, TemplateView):
    """
    The exercise editor shell — teachers only.

    The gate is the same :func:`is_teacher` check the editing API enforces, so
    a student who guesses the URL is refused here *and* at every endpoint the
    page would call.  ``raise_exception`` is deliberate: bouncing a signed-in
    student to the login page would suggest signing in again fixes it.

    ``ensure_csrf_cookie`` because every save is a fetch() carrying the token.
    """

    template_name = "rea_frontend/editor.html"
    raise_exception = True

    def test_func(self):
        return is_teacher(self.request.user)
