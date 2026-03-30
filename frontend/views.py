# frontend/views.py
from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth import login, authenticate, logout
from django.contrib.auth.decorators import login_required
from django.contrib import messages
from rest_framework import viewsets
from users import permissions
from rest_framework.decorators import action
from users.models import User, Instrument, UserInstrument
from .forms import CustomUserCreationForm, LoginForm, UserInstrumentForm, ExerciseForm
from library.models import Exercise, Lesson, Category, Approach, LessonType, LessonGroup
from library.serializers import ExerciseSerializer


def home(request):
    if request.user.is_authenticated:
        return redirect('dashboard')
    return landing_page(request)


def landing_page(request):
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
    logout(request)
    messages.info(request, "You have successfully logged out.")
    return redirect('landing_page')


@login_required
def dashboard(request):
    user_instruments = UserInstrument.objects.filter(user=request.user)
    context = {
        'user': request.user,
        'user_instruments': user_instruments,
    }
    return render(request, 'users/dashboard.html', context)


@login_required
def profile_view(request, username):
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
    if request.method == 'POST':
        form = UserInstrumentForm(request.POST)
        if form.is_valid():
            user_instrument = form.save(commit=False)
            user_instrument.user = request.user

            if UserInstrument.objects.filter(
                user=request.user,
                instrument=user_instrument.instrument
            ).exists():
                messages.error(request, "You've already added this instrument to your profile.")
                return redirect('add_instrument')

            user_instrument.save()
            messages.success(request, f"Added {user_instrument.instrument.name} to your profile!")
            return redirect('dashboard')
    else:
        form = UserInstrumentForm()

    return render(request, 'users/add_instrument.html', {'form': form})


# ---------------------------------------------------------------------------
# Exercise ViewSet
# ---------------------------------------------------------------------------

class ExerciseViewSet(viewsets.ModelViewSet):
    """ViewSet for viewing and editing Exercise instances."""

    queryset = Exercise.objects.all().order_by('-created')
    serializer_class = ExerciseSerializer
    permission_classes = [permissions.IsTeacherOrAdmin]

    def get_queryset(self):
        queryset = super().get_queryset()

        context = self.request.query_params.get('context')
        if context:
            queryset = queryset.filter(context=context)

        category = self.request.query_params.get('category')
        if category:
            queryset = queryset.filter(category=category)

        polyphonic = self.request.query_params.get('polyphonic')
        if polyphonic:
            queryset = queryset.filter(polyphonic=polyphonic)

        return queryset

    @action(detail=False, methods=['get'])
    def dashboard(self, request):
        context = {
            'exercises': self.get_queryset(),
            'pitch_exercises': Exercise.objects.filter(category='pitch').count(),
            'rhythm_exercises': Exercise.objects.filter(category='rhythm').count(),
        }
        return render(request, 'exercises/dashboard.html', context)

    @action(detail=True, methods=['get'])
    def detail_view(self, request, pk=None):
        exercise = self.get_object()
        return render(request, 'exercises/detail.html', {'exercise': exercise})

    @action(detail=False, methods=['get', 'post'])
    def create_form(self, request):
        if request.method == 'POST':
            form = ExerciseForm(request.POST, request.FILES)
            if form.is_valid():
                exercise = form.save()
                messages.success(request, 'Exercise created successfully!')
                return redirect('exercise-detail', pk=exercise.id)
        else:
            form = ExerciseForm()
        return render(request, 'exercises/create_exercise.html', {'form': form})

    @action(detail=False, methods=['get', 'post'])
    def upload_form(self, request):
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
        exercise = self.get_object()
        exercise.delete()
        messages.success(request, 'Exercise deleted successfully!')
        return redirect('exercise-dashboard')

    @action(detail=True, methods=['post'])
    def score_viewer(self, request, pk=None):
        exercise = self.get_object()
        return render(request, 'exercises/score_view.html', {'exercise': exercise})


# ---------------------------------------------------------------------------
# Lesson ViewSet
# ---------------------------------------------------------------------------

class LessonViewSet(viewsets.ViewSet):
    """Frontend ViewSet for browsing the Lesson curriculum tree."""

    permission_classes = [permissions.IsTeacherOrAdmin]

    @action(detail=False, methods=['get'])
    def lesson_dashboard(self, request):
        """
        Hierarchical lesson browser. Drills down via query params:
            ?category=<id>       – enter a Category
            ?approach=<id>       – enter an Approach
            ?lesson_type=<id>    – enter a LessonType
            ?group=<id>          – enter a LessonGroup node
            ?search=<term>       – full-text search across lesson titles
        """
        active_category    = None
        active_approach    = None
        active_lesson_type = None
        active_group       = None

        cat_id = request.query_params.get('category')
        app_id = request.query_params.get('approach')
        lt_id  = request.query_params.get('lesson_type')
        grp_id = request.query_params.get('group')
        search = request.query_params.get('search', '').strip()

        if cat_id:
            active_category = get_object_or_404(Category, pk=cat_id)
        if app_id:
            active_approach = get_object_or_404(Approach, pk=app_id)
        if lt_id:
            active_lesson_type = get_object_or_404(LessonType, pk=lt_id)
        if grp_id:
            active_group = get_object_or_404(LessonGroup, pk=grp_id)

        # Determine what to display at the current drill-down level
        child_items = None
        child_type  = None   # 'category' | 'approach' | 'lesson_type' | 'group'
        lessons     = None

        if search:
            lessons = (
                Lesson.objects
                .filter(title__icontains=search)
                .select_related(
                    'group',
                    'group__lesson_type',
                    'group__lesson_type__approach',
                    'group__lesson_type__approach__category',
                    'group__key',
                )
                .prefetch_related('exercises')
                .order_by('order', 'folder_name')
            )

        elif active_group:
            child_groups = LessonGroup.objects.filter(parent=active_group).order_by('order', 'name')
            if child_groups.exists():
                child_items = child_groups
                child_type  = 'group'
            else:
                lessons = (
                    Lesson.objects
                    .filter(group=active_group)
                    .prefetch_related('exercises')
                    .order_by('order', 'folder_name')
                )

        elif active_lesson_type:
            child_items = LessonGroup.objects.filter(
                lesson_type=active_lesson_type, parent=None
            ).order_by('order', 'name')
            child_type = 'group'

        elif active_approach:
            child_items = LessonType.objects.filter(
                approach=active_approach
            ).order_by('order', 'name')
            child_type = 'lesson_type'

        elif active_category:
            child_items = Approach.objects.filter(
                category=active_category
            ).order_by('name')
            child_type = 'approach'

        else:
            child_items = Category.objects.all().order_by('name')
            child_type  = 'category'

        # Breadcrumb for the current drill-down path
        breadcrumb = _build_dashboard_breadcrumb(
            active_category, active_approach, active_lesson_type, active_group
        )

        # Stats
        total_lessons   = Lesson.objects.count()
        total_exercises = Exercise.objects.count()
        category_counts = {
            c.pk: Lesson.objects.filter(
                group__lesson_type__approach__category=c
            ).count()
            for c in Category.objects.all()
        }

        context = {
            'active_category':    active_category,
            'active_approach':    active_approach,
            'active_lesson_type': active_lesson_type,
            'active_group':       active_group,
            'child_items':        child_items,
            'child_type':         child_type,
            'lessons':            lessons,
            'search':             search,
            'breadcrumb':         breadcrumb,
            'all_categories':     Category.objects.all().order_by('name'),
            'total_lessons':      total_lessons,
            'total_exercises':    total_exercises,
            'category_counts':    category_counts,
        }
        return render(request, 'lessons/dashboard.html', context)

    @action(detail=True, methods=['get'])
    def lesson_detail(self, request, pk=None):
        """Detail view for a single Lesson and its exercises."""
        lesson = get_object_or_404(
            Lesson.objects
            .select_related(
                'group',
                'group__parent',
                'group__lesson_type',
                'group__lesson_type__approach',
                'group__lesson_type__approach__category',
                'group__key',
            )
            .prefetch_related('exercises'),
            pk=pk,
        )

        breadcrumb = _build_lesson_breadcrumb(lesson)

        # Prev / next siblings within the same group
        siblings = list(
            Lesson.objects
            .filter(group=lesson.group)
            .order_by('order', 'folder_name')
            .values_list('id', flat=True)
        )
        idx     = siblings.index(lesson.id) if lesson.id in siblings else 0
        prev_id = siblings[idx - 1] if idx > 0 else None
        next_id = siblings[idx + 1] if idx < len(siblings) - 1 else None

        context = {
            'lesson':     lesson,
            'exercises':  lesson.exercises.all(),
            'breadcrumb': breadcrumb,
            'prev_id':    prev_id,
            'next_id':    next_id,
        }
        return render(request, 'lessons/detail.html', context)


# ---------------------------------------------------------------------------
# Breadcrumb helpers
# ---------------------------------------------------------------------------

def _build_dashboard_breadcrumb(category, approach, lesson_type, group):
    """Ordered (label, url) list for the dashboard drill-down."""
    crumbs = [('Lessons', '/lessons/')]

    if category:
        crumbs.append((str(category), f'/lessons/?category={category.pk}'))
    if approach:
        crumbs.append((approach.get_name_display(), f'/lessons/?approach={approach.pk}'))
    if lesson_type:
        crumbs.append((lesson_type.name, f'/lessons/?lesson_type={lesson_type.pk}'))
    if group:
        # Walk up to collect ancestor groups
        chain = []
        node = group
        while node is not None:
            chain.append(node)
            node = node.parent
        chain.reverse()
        for grp in chain:
            crumbs.append((grp.name, f'/lessons/?group={grp.pk}'))

    return crumbs


def _build_lesson_breadcrumb(lesson):
    """Ordered (label, url) list from Category down to the Lesson."""
    crumbs = [('Lessons', '/lessons/')]

    group_chain = []
    node = lesson.group
    while node is not None:
        group_chain.append(node)
        node = node.parent
    group_chain.reverse()

    root = group_chain[0] if group_chain else lesson.group
    if root.lesson_type:
        lt  = root.lesson_type
        app = lt.approach
        cat = app.category
        crumbs.append((str(cat),  f'/lessons/?category={cat.pk}'))
        crumbs.append((app.get_name_display(), f'/lessons/?approach={app.pk}'))
        crumbs.append((lt.name,   f'/lessons/?lesson_type={lt.pk}'))

    for grp in group_chain:
        crumbs.append((grp.name, f'/lessons/?group={grp.pk}'))

    crumbs.append((lesson.title or lesson.folder_name, None))
    return crumbs