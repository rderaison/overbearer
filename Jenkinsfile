pipeline {
    agent any

    environment {
        REGISTRY           = 'ghcr.io/rderaison/overbearer'
        IMAGE_TAG          = "${(env.BRANCH_NAME ?: 'main') == 'main' ? 'latest' : env.BRANCH_NAME}-${env.BUILD_NUMBER}"
        DOCKER_API_VERSION = '1.43'
    }

    stages {
        stage('Build Images') {
            parallel {
                stage('Proxy Image') {
                    steps {
                        sh "docker build -f Dockerfile.proxy -t ${REGISTRY}/proxy:${IMAGE_TAG} ."
                    }
                }
                stage('Management Image') {
                    steps {
                        sh "docker build -f Dockerfile.api -t ${REGISTRY}/management:${IMAGE_TAG} ."
                    }
                }
            }
        }

        stage('Push Images') {
            when {
                anyOf {
                    branch 'main'
                    buildingTag()
                }
            }
            steps {
                withCredentials([usernamePassword(credentialsId: 'GHCR_IO_LOGIN', usernameVariable: 'USER', passwordVariable: 'TOKEN')]) {
                    sh 'echo $TOKEN | docker login ghcr.io -u $USER --password-stdin'
                }
                sh "docker push ${REGISTRY}/proxy:${IMAGE_TAG}"
                sh "docker push ${REGISTRY}/management:${IMAGE_TAG}"
                script {
                    if ((env.BRANCH_NAME ?: 'main') == 'main') {
                        sh "docker tag ${REGISTRY}/proxy:${IMAGE_TAG} ${REGISTRY}/proxy:latest"
                        sh "docker tag ${REGISTRY}/management:${IMAGE_TAG} ${REGISTRY}/management:latest"
                        sh "docker push ${REGISTRY}/proxy:latest"
                        sh "docker push ${REGISTRY}/management:latest"
                    }
                }
            }
        }
    }

    post {
        always {
            sh 'docker image prune -f --filter="label=overbearer" || true'
        }
        failure {
            echo 'Build failed!'
        }
        success {
            echo "Images: ${REGISTRY}/proxy:${IMAGE_TAG}, ${REGISTRY}/management:${IMAGE_TAG}"
        }
    }
}
