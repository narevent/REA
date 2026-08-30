"""Signup and profile forms."""

from django import forms
from django.conf import settings
from django.contrib.auth.forms import AuthenticationForm, UserCreationForm
from django.contrib.auth.models import User

from .models import Profile, Role


def teacher_signup_allowed():
    """
    Whether the signup form offers the teacher role at all.

    Self-selecting "teacher" is convenient while the app is small, but it is
    the role that will eventually be able to create and delete exercises, so
    the choice sits behind a setting: turn it off and everyone signs up as a
    student, with teachers promoted from the admin.
    """
    return getattr(settings, "REA_ALLOW_TEACHER_SELF_SIGNUP", True)


class SignupForm(UserCreationForm):
    """Username + password (Django's own rules) plus the role and display name."""

    email = forms.EmailField(
        required=False,
        help_text="Optional — only used to identify your account.",
    )
    display_name = forms.CharField(
        max_length=80,
        required=False,
        label="Display name",
        help_text="Optional — shown instead of your username.",
    )
    role = forms.ChoiceField(
        choices=Role.choices,
        initial=Role.STUDENT,
        widget=forms.RadioSelect,
        help_text="Students practise and have their progress tracked. "
                  "Teachers will author exercises.",
    )

    class Meta(UserCreationForm.Meta):
        model = User
        fields = ("username", "email")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if not teacher_signup_allowed():
            # Drop the field rather than narrowing its choices.  Narrowing
            # would turn a posted "teacher" into a validation error and reject
            # the whole signup; removing it means the posted value is simply
            # ignored, which is what "the server decides the role" should do.
            del self.fields["role"]

    def save(self, commit=True):
        user = super().save(commit=False)
        user.email = self.cleaned_data.get("email", "")
        if commit:
            user.save()
            # The post_save signal has created the profile by now.
            profile = user.profile
            # Absent when self-signup is off, in which case nobody may pick.
            profile.role = self.cleaned_data.get("role") or Role.STUDENT
            profile.display_name = self.cleaned_data.get("display_name", "")
            profile.save()
        return user


class LoginForm(AuthenticationForm):
    """Django's login form; subclassed so the template can style it uniformly."""


class ProfileForm(forms.ModelForm):
    """What a signed-in user may change about themselves — not their role."""

    class Meta:
        model = Profile
        fields = ("display_name",)
        labels = {"display_name": "Display name"}
