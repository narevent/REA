from django.views.generic import TemplateView


class IndexView(TemplateView):
    template_name = "rea_frontend/index.html"