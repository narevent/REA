# frontend/views.py
from django.shortcuts import render, redirect
from django.contrib.auth import login, authenticate, logout
from django.contrib.auth.decorators import login_required
from django.contrib import messages
from rest_framework import viewsets #permissions
from users import permissions
from rest_framework.decorators import action
from users.models import User, Instrument, UserInstrument
from .forms import CustomUserCreationForm, LoginForm, UserInstrumentForm, ExerciseForm
from library.models import Exercise
from library.serializers import ExerciseSerializer


def home(request):
    """
    Home view that redirects to dashboard if logged in, 
    otherwise shows the landing page.
    """
    if request.user.is_authenticated:
        return redirect('dashboard')
    else:
        return landing_page(request)


def landing_page(request):
    """
    Landing page view with information about the platform.
    Only for non-authenticated users.
    """
    if request.user.is_authenticated:
        return redirect('dashboard')
        
    instruments_count = Instrument.objects.count()
    teachers_count = User.objects.filter(user_type='teacher').count()
    students_count = User.objects.filter(user_type='student').count()
    
    context = {
        'instruments_count': instruments_count,
        'teachers_count': teachers_count,
        'students_count': students_count,
    }
    return render(request, 'frontend/landing_page.html', context)


def signup_view(request):
    """
    User registration view.
    """
    if request.user.is_authenticated:
        return redirect('dashboard')
        
    if request.method == 'POST':
        form = CustomUserCreationForm(request.POST)
        if form.is_valid():
            user = form.save()
            login(request, user)
            messages.success(request, "Registration successful. Welcome to REA!")
            return redirect('dashboard')
        else:
            messages.error(request, "Registration failed. Please check the form.")
    else:
        form = CustomUserCreationForm()
        
    return render(request, 'users/signup.html', {'form': form})


def login_view(request):
    """
    User login view.
    """
    if request.user.is_authenticated:
        return redirect('dashboard')
        
    if request.method == 'POST':
        form = LoginForm(request, data=request.POST)
        if form.is_valid():
            username = form.cleaned_data.get('username')
            password = form.cleaned_data.get('password')
            user = authenticate(username=username, password=password)
            if user is not None:
                login(request, user)
                messages.success(request, f"Welcome back, {user.first_name or user.username}!")
                return redirect('dashboard')
        else:
            messages.error(request, "Invalid username or password.")
    else:
        form = LoginForm()
        
    return render(request, 'users/login.html', {'form': form})


def logout_view(request):
    """
    User logout view.
    """
    logout(request)
    messages.info(request, "You have successfully logged out.")
    return redirect('landing_page')


@login_required
def dashboard(request):
    """
    User dashboard view.
    """
    user_instruments = UserInstrument.objects.filter(user=request.user)
    
    context = {
        'user': request.user,
        'user_instruments': user_instruments,
    }
    return render(request, 'users/dashboard.html', context)


@login_required
def profile_view(request, username):
    """
    View for viewing a user's profile.
    """
    try:
        profile_user = User.objects.get(username=username)
    except User.DoesNotExist:
        messages.error(request, "User does not exist.")
        return redirect('dashboard')
        
    user_instruments = UserInstrument.objects.filter(user=profile_user)
    
    context = {
        'profile_user': profile_user,
        'user_instruments': user_instruments,
    }
    return render(request, 'users/profile.html', context)


@login_required
def add_instrument_view(request):
    """
    View for adding an instrument to the logged-in user's profile.
    """
    if request.method == 'POST':
        form = UserInstrumentForm(request.POST)
        if form.is_valid():
            user_instrument = form.save(commit=False)
            user_instrument.user = request.user
            
            # Check if this instrument is already added for this user
            if UserInstrument.objects.filter(user=request.user, instrument=user_instrument.instrument).exists():
                messages.error(request, "You've already added this instrument to your profile.")
                return redirect('add_instrument')
                
            user_instrument.save()
            messages.success(request, f"Added {user_instrument.instrument.name} to your profile!")
            return redirect('dashboard')
    else:
        form = UserInstrumentForm()
        
    return render(request, 'users/add_instrument.html', {'form': form})


class ExerciseViewSet(viewsets.ModelViewSet):
    """
    ViewSet for viewing and editing Exercise instances.
    """
    queryset = Exercise.objects.all().order_by('-created')
    serializer_class = ExerciseSerializer
    permission_classes = [permissions.IsTeacherOrAdmin]
    
    def get_queryset(self):
        """
        Filter exercises based on query parameters.
        """
        queryset = super().get_queryset()
        
        # Filter by context if provided
        context = self.request.query_params.get('context')
        if context:
            queryset = queryset.filter(context=context)
        
        # Filter by category if provided
        category = self.request.query_params.get('category')
        if category:
            queryset = queryset.filter(category=category)
        
        # Filter by voices if provided
        polyphonic = self.request.query_params.get('polyphonic')
        if polyphonic:
            queryset = queryset.filter(polyphonic=polyphonic)
        
        return queryset
    
    @action(detail=False, methods=['get'])
    def dashboard(self, request):
        """
        Show a dashboard view of exercises.
        """
        context = {
            'exercises': self.get_queryset(),
            'pitch_exercises': Exercise.objects.filter(category='pitch').count(),
            'rhythm_exercises': Exercise.objects.filter(category='rhythm').count(),
        }
        return render(request, 'exercises/dashboard.html', context)
    
    @action(detail=True, methods=['get'])
    def detail_view(self, request, pk=None):
        """
        Show a detailed view of a specific exercise.
        """
        exercise = self.get_object()
        context = {
            'exercise': exercise,
        }
        return render(request, 'exercises/detail.html', context)
    
    @action(detail=False, methods=['get', 'post'])
    def create_form(self, request):
        """
        Show a form for creating a new exercise and handle form submission.
        """
        if request.method == 'POST':
            form = ExerciseForm(request.POST, request.FILES)
            if form.is_valid():
                exercise = form.save()
                messages.success(request, 'Exercise created successfully!')
                return redirect('exercise-detail', pk=exercise.id)
            else:
                print('JAMMER')
        else:
            form = ExerciseForm()
        
        return render(request, 'exercises/create_exercise.html', {'form': form})
    
    @action(detail=False, methods=['get', 'post'])
    def upload_form(self, request):
        """
        Show a form for creating a new exercise and handle form submission.
        """
        if request.method == 'POST':
            form = ExerciseForm(request.POST, request.FILES)
            if form.is_valid():
                exercise = form.save()
                messages.success(request, 'Exercise created successfully!')
                return redirect('exercise-detail', pk=exercise.id)
        else:
            form = ExerciseForm()
        
        return render(request, 'exercises/form.html', {'form': form})
    
    @action(detail=True, methods=['get', 'post'])
    def update_form(self, request, pk=None):
        """
        Show a form for updating an existing exercise and handle form submission.
        """
        exercise = self.get_object()
        
        if request.method == 'POST':
            form = ExerciseForm(request.POST, request.FILES, instance=exercise)
            if form.is_valid():
                form.save()
                messages.success(request, 'Exercise updated successfully!')
                return redirect('exercise-detail', pk=exercise.id)
        else:
            form = ExerciseForm(instance=exercise)
        
        return render(request, 'exercises/form.html', {'form': form})
    
    @action(detail=True, methods=['post'])
    def delete(self, request, pk=None):
        """
        Delete an exercise.
        """
        exercise = self.get_object()
        exercise.delete()
        messages.success(request, 'Exercise deleted successfully!')
        return redirect('exercise-dashboard')
    
    @action(detail=True, methods=['post'])
    def score_viewer(self, request, pk=None):
        """
        Show a detailed view of a specific exercise.
        """
        exercise = self.get_object()
        print(exercise.midi)
        context = {
            'exercise': exercise,
        }
        return render(request, 'exercises/score_view.html', context)