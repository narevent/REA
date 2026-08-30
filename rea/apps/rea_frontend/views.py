from django.contrib.auth.mixins import LoginRequiredMixin
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.generic import TemplateView


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
