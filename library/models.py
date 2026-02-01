from django.db import models

class Module(models.Model):
    context = models.CharField(max_length=3, choices=(('rel', 'Relative',), ('abs', 'Absolute')), default='rel')


class Exercise(models.Model):
    midi = models.FileField(upload_to='midi', blank=True, null=True)
    svg = models.FileField(upload_to='svg', blank=True, null=True)
    category = models.CharField(max_length=6, choices=(('pitch', 'Intonation',), ('rhythm', 'Rhythm')), default='pitch')
    polyphonic = models.BooleanField(default=False)

    created = models.DateTimeField(auto_now_add=True)
    modified = models.DateTimeField(auto_now=True)
