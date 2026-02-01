# users/models.py
from django.db import models
from django.contrib.auth.models import AbstractUser


class Instrument(models.Model):
    """
    Model representing a musical instrument.
    """
    name = models.CharField(max_length=100)
    family = models.CharField(max_length=50, help_text="e.g., String, Woodwind, Brass, Percussion")
    description = models.TextField(blank=True)
    
    def __str__(self):
        return self.name
    
    class Meta:
        ordering = ['name']


class UserInstrument(models.Model):
    """
    Intermediate model for User-Instrument relationship with proficiency level.
    """
    PROFICIENCY_CHOICES = (
        ('beginner', 'Beginner'),
        ('intermediate', 'Intermediate'),
        ('advanced', 'Advanced'),
        ('expert', 'Expert'),
    )
    
    user = models.ForeignKey('User', on_delete=models.CASCADE, related_name='user_instruments')
    instrument = models.ForeignKey(Instrument, on_delete=models.CASCADE, related_name='player_profiles')
    proficiency = models.CharField(max_length=15, choices=PROFICIENCY_CHOICES, default='beginner')
    years_of_experience = models.PositiveIntegerField(default=0)
    notes = models.TextField(blank=True)
    
    class Meta:
        unique_together = ('user', 'instrument')
        
    def __str__(self):
        return f"{self.user.username} - {self.instrument.name} ({self.get_proficiency_display()})"


class User(AbstractUser):
    """
    Custom User model that extends Django's AbstractUser.
    Users can be either teachers or students in a music education context.
    """
    USER_TYPE_CHOICES = (
        ('teacher', 'Teacher'),
        ('student', 'Student'),
    )
    
    user_type = models.CharField(max_length=10, choices=USER_TYPE_CHOICES)
    date_of_birth = models.DateField(null=True, blank=True)
    instruments = models.ManyToManyField(Instrument, through=UserInstrument, related_name='players')
    
    def __str__(self):
        return f"{self.username} ({self.get_user_type_display()})"
    
    class Meta:
        db_table = 'users'
        swappable = 'AUTH_USER_MODEL'