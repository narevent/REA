# frontend/forms.py
from django import forms
from django.contrib.auth.forms import UserCreationForm, AuthenticationForm
from users.models import User, UserInstrument
from library.models import Exercise


class CustomUserCreationForm(UserCreationForm):
    """
    Custom form for user registration that includes fields for user type.
    """
    first_name = forms.CharField(max_length=30, required=True)
    last_name = forms.CharField(max_length=30, required=True)
    email = forms.EmailField(required=True)
    date_of_birth = forms.DateField(
        widget=forms.DateInput(attrs={'type': 'date'}),
        required=False
    )
    
    class Meta:
        model = User
        fields = ('username', 'first_name', 'last_name', 'email', 
                  'user_type', 'date_of_birth', 'password1', 'password2')
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Add custom styling to form fields
        for field_name, field in self.fields.items():
            field.widget.attrs.update({
                'class': 'form-control',
                'placeholder': field.label
            })


class LoginForm(AuthenticationForm):
    """
    Custom login form with styling.
    """
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Add custom styling to form fields
        for field_name, field in self.fields.items():
            field.widget.attrs.update({
                'class': 'form-control',
                'placeholder': field.label
            })


class UserInstrumentForm(forms.ModelForm):
    """
    Form for adding instruments to a user's profile.
    """
    class Meta:
        model = UserInstrument
        fields = ('instrument', 'proficiency', 'years_of_experience', 'notes')
        widgets = {
            'notes': forms.Textarea(attrs={'rows': 3}),
        }
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Add custom styling to form fields
        for field_name, field in self.fields.items():
            field.widget.attrs.update({
                'class': 'form-control'
            })


class ExerciseForm(forms.ModelForm):
    class Meta:
        model = Exercise
        fields = ['midi', 'svg', 'category']
        
    def clean(self):
        cleaned_data = super().clean()
        # Ensure at least one file type is uploaded
        file_fields = ['midi', 'svg']
        
        if not any(cleaned_data.get(field) for field in file_fields):
            raise forms.ValidationError("At least one file must be uploaded.")
        
        return cleaned_data