# users/views.py
from rest_framework import viewsets, permissions, filters, status
from rest_framework.decorators import action
from rest_framework.response import Response
from django.shortcuts import get_object_or_404
from .models import User, Instrument, UserInstrument
from .serializers import (
    UserSerializer, UserCreateSerializer, 
    TeacherSerializer, StudentSerializer,
    InstrumentSerializer, UserInstrumentSerializer
)
from .permissions import IsUserOrAdmin, IsTeacherOrAdmin


class InstrumentViewSet(viewsets.ModelViewSet):
    """
    API endpoint for managing instruments.
    """
    queryset = Instrument.objects.all()
    serializer_class = InstrumentSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['name', 'family']
    ordering_fields = ['name', 'family']
    
    def get_permissions(self):
        """
        - List/retrieve: Any authenticated user
        - Create/update/destroy: Only teachers or admins
        """
        if self.action in ['create', 'update', 'partial_update', 'destroy']:
            permission_classes = [IsTeacherOrAdmin]
        else:
            permission_classes = [permissions.IsAuthenticated]
        return [permission() for permission in permission_classes]


class UserInstrumentViewSet(viewsets.ModelViewSet):
    """
    API endpoint for managing user-instrument relationships.
    """
    queryset = UserInstrument.objects.all()
    serializer_class = UserInstrumentSerializer
    
    def get_queryset(self):
        """
        Filter queryset based on user permissions.
        """
        queryset = UserInstrument.objects.all()
        
        # Filter by user ID if provided in query params
        user_id = self.request.query_params.get('user', None)
        if user_id is not None:
            queryset = queryset.filter(user_id=user_id)
        # If not admin and not filtering by user, only show own instruments
        elif not self.request.user.is_staff:
            queryset = queryset.filter(user=self.request.user)
            
        return queryset
    
    def perform_create(self, serializer):
        """
        Set the user to the requesting user if not specified.
        """
        # Get the user_id from the URL if it exists
        user_id = self.request.query_params.get('user', None)
        
        # If not specified in URL, use the authenticated user
        if not user_id:
            serializer.save(user=self.request.user)
        else:
            # Check if the user has permission to add instrument to this user
            if not self.request.user.is_staff and str(user_id) != str(self.request.user.id):
                raise permissions.exceptions.PermissionDenied()
            serializer.save(user_id=user_id)


class UserViewSet(viewsets.ModelViewSet):
    """
    API endpoint for managing users.
    """
    queryset = User.objects.all()
    serializer_class = UserSerializer
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ['username', 'email', 'first_name', 'last_name']
    ordering_fields = ['username', 'date_joined', 'user_type']
    
    def get_permissions(self):
        """
        - List/retrieve: Any authenticated user
        - Create: Any user (including anonymous) can create an account
        - Update/destroy: Only admin or the user themselves
        """
        if self.action == 'create':
            permission_classes = [permissions.AllowAny]
        elif self.action in ['update', 'partial_update', 'destroy']:
            permission_classes = [IsUserOrAdmin]
        else:
            permission_classes = [permissions.IsAuthenticated]
        return [permission() for permission in permission_classes]
    
    def get_serializer_class(self):
        if self.action == 'create':
            return UserCreateSerializer
        return UserSerializer
    
    @action(detail=True, methods=['get', 'post'])
    def add_instrument(self, request, pk=None):
        """
        Add an instrument to a user's profile.
        GET: Returns a form for adding an instrument
        POST: Processes the form submission
        """
        user = self.get_object()
        
        # Handle GET request - show form or return empty data
        if request.method == 'GET':
            return Response({})
        
        # Handle POST request - process form data
        # Check permissions
        if not request.user.is_staff and request.user != user:
            return Response(
                {"detail": "You do not have permission to add instruments to this user."},
                status=status.HTTP_403_FORBIDDEN
            )
        
        # Add the user to the data
        serializer = UserInstrumentSerializer(data=request.data)
        if serializer.is_valid():
            serializer.save(user=user)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    @action(detail=False, methods=['get'])
    def teachers(self, request):
        """
        Return a list of all teachers.
        """
        teachers = User.objects.filter(user_type='teacher')
        serializer = TeacherSerializer(teachers, many=True)
        return Response(serializer.data)
    
    @action(detail=False, methods=['get'])
    def students(self, request):
        """
        Return a list of all students.
        """
        students = User.objects.filter(user_type='student')
        serializer = StudentSerializer(students, many=True)
        return Response(serializer.data)
    
    @action(detail=False, methods=['get'])
    def me(self, request):
        """
        Return the authenticated user's details.
        """
        serializer = UserSerializer(request.user)
        return Response(serializer.data)
    
    @action(detail=True, methods=['get'])
    def instruments(self, request, pk=None):
        """
        List all instruments for a given user.
        """
        user = self.get_object()
        instruments = UserInstrument.objects.filter(user=user)
        serializer = UserInstrumentSerializer(instruments, many=True)
        return Response(serializer.data)
