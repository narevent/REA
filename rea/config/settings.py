"""
Django settings for the REA (Relative Ear-training Architecture) project.
"""

from pathlib import Path
import os

BASE_DIR = Path(__file__).resolve().parent.parent.parent

SECRET_KEY = os.environ.get(
    "REA_SECRET_KEY", "dev-secret-key-change-me-in-production"
)
DEBUG = os.environ.get("REA_DEBUG", "true").lower() in ("1", "true", "yes")
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "django_filters",
    "corsheaders",
    # local apps
    "rea.apps.accounts",
    "rea.apps.rea_api",
    "rea.apps.rea_api.intonation.relative",
    "rea.apps.rea_api.intonation.absolute",
    "rea.apps.rea_frontend",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "rea.config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "rea" / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "rea.config.wsgi.application"
ASGI_APPLICATION = "rea.config.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "rea" / "db.sqlite3",
    }
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "rea" / "static"
STATICFILES_DIRS = [
    BASE_DIR / "rea" / "apps" / "rea_frontend" / "static",
]

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# REST framework
REST_FRAMEWORK = {
    "DEFAULT_RENDERER_CLASSES": [
        "rest_framework.renderers.JSONRenderer",
        "rest_framework.renderers.BrowsableAPIRenderer",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 50,
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
    ],
}

CORS_ALLOW_ALL_ORIGINS = True

# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------
LOGIN_URL = "accounts:login"
LOGIN_REDIRECT_URL = "accounts:dashboard"
LOGOUT_REDIRECT_URL = "rea_frontend:index"

# Whether the signup form lets someone choose the teacher role for themselves.
# Teachers will be able to create and delete exercises, so on any deployment
# where that matters, set this to False and promote teachers from the admin
# instead (Accounts -> Profiles -> role).
REA_ALLOW_TEACHER_SELF_SIGNUP = True

# The session and CSRF cookies now carry a real login, so outside DEBUG they
# are restricted to HTTPS.  CSRF_COOKIE_HTTPONLY is deliberately left False:
# the practice app reads the token from JavaScript to POST completed sessions.
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"

# Path to the relative data (key_models / exercises) living next to the project.
REA_DATA_DIR = BASE_DIR / "relative"
# Path to the absolute data (key_models / lessons) living next to the project.
REA_ABSOLUTE_DATA_DIR = BASE_DIR / "absolute"