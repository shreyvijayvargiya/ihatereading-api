import hnswlib
import numpy as np

# Create data
dim = 128
num_elements = 10000
data = np.random.rand(num_elements, dim).astype(np.float32)

# Initialize index
p = hnswlib.Index(space='cosine', dim=dim)
p.init_index(max_elements=num_elements, ef_construction=200, M=16)

# Add data
p.add_items(data)

# Set search parameter
p.set_ef(50)

# Query
query = np.random.rand(1, dim).astype(np.float32)
labels, distances = p.knn_query(query, k=5)
print(labels, distances)
