from rest_framework import serializers
from .models import Exercise

class ExerciseSerializer(serializers.ModelSerializer):
    class Meta:
        model = Exercise
        fields = [
            'id',
            'midi',
            'svg',
            'category',
            'created',
            'modified',
        ]
        read_only_fields = ['created', 'modified']