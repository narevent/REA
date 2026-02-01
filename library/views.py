from rest_framework import viewsets
from rest_framework.permissions import IsAuthenticatedOrReadOnly
from .models import Exercise
from .serializers import ExerciseSerializer

class ExerciseViewSet(viewsets.ModelViewSet):
    """
    ViewSet for viewing and editing exercises.
    """
    queryset = Exercise.objects.all()
    serializer_class = ExerciseSerializer
    permission_classes = [IsAuthenticatedOrReadOnly]
    
    def get_queryset(self):
        """
        Optionally restricts the returned exercises by filtering against
        query parameters in the URL.
        """
        queryset = Exercise.objects.all()
        
        # Filter by context if provided
        context = self.request.query_params.get('context', None)
        if context is not None:
            queryset = queryset.filter(context=context)
            
        # Filter by category if provided
        category = self.request.query_params.get('category', None)
        if category is not None:
            queryset = queryset.filter(category=category)
            
        return queryset