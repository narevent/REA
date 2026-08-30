"""
Account pages: sign up, sign in, and the profile dashboard.

These are ordinary server-rendered Django views rather than screens inside the
practice SPA.  Signing in is a page-level transition, and doing it server-side
keeps Django's password validation, CSRF handling and session management doing
their job instead of being reimplemented over fetch.  The pages load the same
stylesheet as the app, so they look like part of it.
"""

from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth.mixins import LoginRequiredMixin
from django.contrib.auth.views import LoginView, LogoutView
from django.shortcuts import redirect
from django.urls import reverse_lazy
from django.views.generic import CreateView, TemplateView, View

from . import progress as progress_calc
from .forms import LoginForm, ProfileForm, SignupForm
from .models import PASS_THRESHOLD


class ReaLoginView(LoginView):
    template_name = "accounts/login.html"
    authentication_form = LoginForm
    redirect_authenticated_user = True

    def get_success_url(self):
        return self.get_redirect_url() or reverse_lazy("accounts:dashboard")


class ReaLogoutView(LogoutView):
    """POST-only, which is Django's default and what the header form uses."""

    next_page = reverse_lazy("rea_frontend:index")


class SignupView(CreateView):
    template_name = "accounts/signup.html"
    form_class = SignupForm
    success_url = reverse_lazy("accounts:dashboard")

    def dispatch(self, request, *args, **kwargs):
        if request.user.is_authenticated:
            return redirect("accounts:dashboard")
        return super().dispatch(request, *args, **kwargs)

    def form_valid(self, form):
        response = super().form_valid(form)
        # Sign the new account straight in — bouncing someone to a login form
        # they have just filled in twice is pure friction.
        login(self.request, self.object)
        messages.success(self.request, "Welcome to REA — your account is ready.")
        return response


class DashboardView(LoginRequiredMixin, TemplateView):
    """
    The profile dashboard.

    Students see their practice history; teachers see their authoring area.
    Both see their account details, so the page is one template with a role
    branch rather than two near-identical pages.
    """

    template_name = "accounts/dashboard.html"

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        user = self.request.user
        profile = user.profile
        ctx["profile"] = profile
        ctx["profile_form"] = kwargs.get("profile_form") or ProfileForm(instance=profile)
        ctx["pass_threshold"] = PASS_THRESHOLD

        if profile.is_teacher:
            ctx["is_teacher"] = True
            return ctx

        trend = progress_calc.daily_trend(user)
        ctx.update({
            "is_teacher": False,
            "overview": progress_calc.overview(user),
            "chapters": progress_calc.chapter_breakdown(user),
            "trend": trend,
            "trend_points": progress_calc.trend_polyline(trend),
            "trend_days": progress_calc.TREND_DAYS,
            "recent": progress_calc.recent_sessions(user),
        })
        return ctx


class ProfileUpdateView(LoginRequiredMixin, View):
    """Save the display name from the dashboard's own small form."""

    def post(self, request, *args, **kwargs):
        form = ProfileForm(request.POST, instance=request.user.profile)
        if form.is_valid():
            form.save()
            messages.success(request, "Profile updated.")
            return redirect("accounts:dashboard")
        # Re-render the dashboard with the invalid form rather than losing it.
        view = DashboardView.as_view()
        return view(request, profile_form=form)
